import * as core from '@actions/core'
import * as github from '@actions/github'
import {GitHub} from '@actions/github/lib/utils'

import {ArtifactProvider} from './input-providers/artifact-provider'
import {FileContent} from './input-providers/input-provider'
import {LocalFileProvider} from './input-providers/local-file-provider'
import {getAnnotations} from './report/get-annotations'
import {getReport} from './report/get-report'
import {ParseOptions, TestParser} from './test-parser'
import {TestRunResult} from './test-results'

import {DartJsonParser} from './parsers/dart-json/dart-json-parser'
import {DotnetTrxParser} from './parsers/dotnet-trx/dotnet-trx-parser'
import {JavaJunitParser} from './parsers/java-junit/java-junit-parser'
import {JestJunitParser} from './parsers/jest-junit/jest-junit-parser'
import {MochaJsonParser} from './parsers/mocha-json/mocha-json-parser'

import {getCheckRunContext} from './utils/github-utils'
import {Icon} from './utils/markdown-utils'
import {normalizeDirPath, normalizeFilePath} from './utils/path-utils'

async function main(): Promise<void> {
  try {
    const testReporter = new TestReporter()
    await testReporter.run()
  } catch (error) {
    if (error instanceof Error) core.setFailed(error)
    else core.setFailed(JSON.stringify(error))
  }
}

class TestReporter {
  readonly artifact = core.getInput('artifact', {required: false})
  readonly name = core.getInput('name', {required: true})
  readonly path = core.getInput('path', {required: true})
  readonly pathReplaceBackslashes = core.getInput('path-replace-backslashes', {required: false}) === 'true'
  readonly reporter = core.getInput('reporter', {required: true})
  readonly listSuites = core.getInput('list-suites', {required: true}) as 'all' | 'failed'
  readonly listTests = core.getInput('list-tests', {required: true}) as 'all' | 'failed' | 'none'
  readonly maxAnnotations = parseInt(core.getInput('max-annotations', {required: true}))
  readonly failOnError = core.getInput('fail-on-error', {required: true}) === 'true'
  readonly failOnNoResults = core.getInput('fail-on-no-results', {required: true}) === 'true'
  readonly workDirInput = core.getInput('working-directory', {
    required: false
  })
  readonly onlySummary = core.getInput('only-summary', {required: false}) === 'true'
  readonly token = core.getInput('token', {required: true})
  readonly runId = parseInt(core.getInput('run-id'), 10)
  readonly runJobName = core.getInput('run-job-name')
  readonly reportCheck = core.getInput('report-check') === 'true'
  readonly reportComment = core.getInput('report-comment') === 'true'
  readonly reportJobSummary = core.getInput('report-job-summary') === 'true'
  readonly octokit: InstanceType<typeof GitHub>
  readonly context = getCheckRunContext()

  constructor() {
    this.octokit = github.getOctokit(this.token)

    if (this.listSuites !== 'all' && this.listSuites !== 'failed') {
      core.setFailed(`Input parameter 'list-suites' has invalid value`)
      return
    }

    if (this.listTests !== 'all' && this.listTests !== 'failed' && this.listTests !== 'none') {
      core.setFailed(`Input parameter 'list-tests' has invalid value`)
      return
    }

    if (isNaN(this.maxAnnotations) || this.maxAnnotations < 0 || this.maxAnnotations > 50) {
      core.setFailed(`Input parameter 'max-annotations' has invalid value`)
      return
    }
  }

  async run(): Promise<void> {
    if (this.workDirInput) {
      core.info(`Changing directory to '${this.workDirInput}'`)
      process.chdir(this.workDirInput)
    }

    core.info(`Check runs will be created with SHA=${this.context.sha}`)

    // Split path pattern by ',' and optionally convert all backslashes to forward slashes
    // fast-glob (micromatch) always interprets backslashes as escape characters instead of directory separators
    const pathsList = this.path.split(',')
    const pattern = this.pathReplaceBackslashes ? pathsList.map(normalizeFilePath) : pathsList

    const inputProvider = this.artifact
      ? new ArtifactProvider(
          this.octokit,
          this.artifact,
          this.name,
          pattern,
          this.context.sha,
          this.context.runId,
          this.token
        )
      : new LocalFileProvider(this.name, pattern)

    const parseErrors = this.maxAnnotations > 0
    const trackedFiles = await inputProvider.listTrackedFiles()
    const workDir = this.artifact ? undefined : normalizeDirPath(process.cwd(), true)

    core.info(`Found ${trackedFiles.length} files tracked by GitHub`)

    const options: ParseOptions = {
      workDir,
      trackedFiles,
      parseErrors
    }

    core.info(`Using test report parser '${this.reporter}'`)
    const parser = this.getParser(this.reporter, options)

    const results: TestRunResult[] = []
    const input = await inputProvider.load()
    for (const [reportName, files] of Object.entries(input)) {
      try {
        core.startGroup(`Creating test report ${reportName}`)
        const tr = await this.createReport(parser, reportName, files)
        results.push(...tr)
      } finally {
        core.endGroup()
      }
    }

    const isFailed = results.some(tr => tr.result === 'failed')
    const conclusion = isFailed ? 'failure' : 'success'
    const passed = results.reduce((sum, tr) => sum + tr.passed, 0)
    const failed = results.reduce((sum, tr) => sum + tr.failed, 0)
    const skipped = results.reduce((sum, tr) => sum + tr.skipped, 0)
    const time = results.reduce((sum, tr) => sum + tr.time, 0)

    core.setOutput('conclusion', conclusion)
    core.setOutput('passed', passed)
    core.setOutput('failed', failed)
    core.setOutput('skipped', skipped)
    core.setOutput('time', time)

    if (this.failOnError && isFailed) {
      core.setFailed(`Failed test were found and 'fail-on-error' option is set to ${this.failOnError}`)
      return
    }

    if (results.length === 0) {
      if (this.failOnNoResults) {
        core.setFailed(`No test report files were found`)
      } else {
        core.warning(`No test report files were found`)
      }
      return
    }
  }

  async createReport(parser: TestParser, name: string, files: FileContent[]): Promise<TestRunResult[]> {
    if (files.length === 0) {
      core.warning(`No file matches path ${this.path}`)
      return []
    }

    const results: TestRunResult[] = []
    for (const {file, content} of files) {
      core.info(`Processing test results from ${file}`)
      const tr = await parser.parse(file, content)
      results.push(tr)
    }

    let newCheck = false
    let checkId: number | undefined
    let baseUrl: string | undefined

    if (this.reportCheck) {
      // Create check run
      core.info(`Creating check run ${name}`)
      const createResp = await this.octokit.rest.checks.create({
        head_sha: this.context.sha,
        name,
        status: 'in_progress',
        output: {
          title: name,
          summary: ''
        },
        ...github.context.repo
      })

      newCheck = true
      checkId = createResp.data.id
      baseUrl = createResp.data.html_url as string
    } else if (this.runId) {
      // Get existing check run based on context
      core.info(`Getting current workflow job for run ${this.runId}`)

      const jobs = await this.octokit.rest.actions.listJobsForWorkflowRun({
        run_id: this.runId,
        per_page: 100,
        ...github.context.repo
      })

      const job = jobs.data.jobs.find(job => job.name?.toLowerCase() === this.runJobName?.toLowerCase())
      checkId = job?.check_run_url
        ? parseInt(job?.check_run_url.substring(job?.check_run_url.lastIndexOf('/') + 1), 10)
        : undefined

      baseUrl = job?.html_url ?? undefined
    } else {
      // Couldn't get check run
      checkId = undefined
      baseUrl = undefined

      core.warning(
        `Not reporting check, but workflow run-id was not provided. Most reporting will be skipped entirely.`
      )
    }

    core.info('Creating report summary')
    const {listSuites, listTests, onlySummary} = this
    const summary = getReport(results, {
      listSuites,
      listTests,
      baseUrl: baseUrl || '',
      onlySummary
    })

    core.info('Creating annotations')
    const annotations = getAnnotations(results, this.maxAnnotations)

    const isFailed = results.some(tr => tr.result === 'failed')
    const conclusion = isFailed ? 'failure' : 'success'
    const icon = isFailed ? Icon.fail : Icon.success

    if (newCheck && checkId) {
      core.info(`Updating check run conclusion (${conclusion}) and output`)
      const resp = await this.octokit.rest.checks.update({
        check_run_id: checkId,
        conclusion,
        status: 'completed',
        output: {
          title: `${name} ${icon}`,
          summary,
          annotations
        },
        ...github.context.repo
      })

      core.info(`Check run create response: ${resp.status}`)
      core.info(`Check run URL: ${resp.data.url}`)
      core.info(`Check run HTML: ${resp.data.html_url}`)
      core.setOutput('url', resp.data.html_url)
    } else if (checkId) {
      core.info(`Updating check run conclusion (${conclusion}) and output`)
      const resp = await this.octokit.rest.checks.update({
        check_run_id: checkId,
        output: {
          annotations
        },
        ...github.context.repo
      })

      core.setOutput('url', resp.data.html_url)
    }

    if (this.reportComment) {
      core.info(`Updating pull request comment with test results`)
      const result = await this.octokit.rest.repos.listPullRequestsAssociatedWithCommit({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        commit_sha: this.context.sha
      })

      const prs = result.data.filter(el => el.state === 'open')
      if (prs.length > 0) {
        const pr = prs[0]

        this.octokit.rest.issues.createComment({
          owner: github.context.repo.owner,
          repo: github.context.repo.repo,
          issue_number: pr.number,
          body: summary
        })
      }
    } else {
      core.info(`Skipping comment with test results`)
    }

    if (this.reportJobSummary) {
      core.info(`Publishing job summary`)
      core.summary.addRaw(summary).write()
    } else {
      core.info(`Skipping job summary`)
    }

    return results
  }

  getParser(reporter: string, options: ParseOptions): TestParser {
    switch (reporter) {
      case 'dart-json':
        return new DartJsonParser(options, 'dart')
      case 'dotnet-trx':
        return new DotnetTrxParser(options)
      case 'flutter-json':
        return new DartJsonParser(options, 'flutter')
      case 'java-junit':
        return new JavaJunitParser(options)
      case 'jest-junit':
        return new JestJunitParser(options)
      case 'mocha-json':
        return new MochaJsonParser(options)
      default:
        throw new Error(`Input variable 'reporter' is set to invalid value '${reporter}'`)
    }
  }
}

main()
