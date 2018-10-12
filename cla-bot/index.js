const fs = require('fs');
const path = require('path');
const contributionVerifier = require('./contributionVerifier');
const installationToken = require('./installationToken');
const is = require('is_js');
const uuid = require('uuid/v4');
const { githubRequest, getLabels, getOrgConfig, getReadmeUrl, getFile, addLabel, getCommits, setStatus, addCommentNoCLA, addCommentNoEmail, deleteLabel, addRecheckComment } = require('./githubApi');
const logger = require('./logger');

const defaultConfig = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'default.json')));

const sortUnique = arr =>
     arr.sort((a, b) => a - b)
        .filter((value, index, self) => self.indexOf(value, index + 1) === -1);

// a token value used to indicate that an organisation-level .clabot file was not found
const noOrgConfig = false;

const sideEffect = fn => d =>
  fn(d).then(() => d);

const validAction = body =>
  body.action === 'opened' ||
  body.action === 'synchronize' ||
  // issues do not have a body.issue.pull_request property, whereas PRs do
  (body.action === 'created' && body.issue.pull_request);

// depending on the event type, the way the location of the PR and issue URLs are different
const gitHubUrls = webhook =>
  (webhook.action === 'created'
    ? {
      pullRequest: webhook.issue.pull_request.url,
      issue: webhook.issue.url
    }
    : {
      pullRequest: webhook.pull_request.url,
      issue: webhook.pull_request.issue_url
    });

const commentSummonsBot = comment =>
  comment.match(new RegExp(`@${process.env.BOT_NAME}(\\[bot\\])?\\s*check`)) !== null;


const response = body => ({
  statusCode: 200,
  body: JSON.stringify(body)
});

exports.handler = ({ body }, lambdaContext, callback) => {
  const correlationKey = uuid();

  body = JSON.parse(body);

  if (!validAction(body)) {
    callback(null, response({ message: `ignored action of type ${body.action}` }));
    return;
  }

  const context = {
    webhook: body,
    gitHubUrls: gitHubUrls(body),
    correlationKey
  };
  const org = context.gitHubUrls.pullRequest.split('/')[4];
  context.logUrl = `${org}-${correlationKey}`;

  const loggingCallback = (error, message) => {
    logger.debug('integration webhook callback response', { error, message });
    logger.flush(context.logUrl).then(() =>
      callback(error, response(message)));
  };

  // PRs include the head sha, for comments we have to determine this from the commit history
  if (body.pull_request) {
    context.headSha = body.pull_request.head.sha;
  }

  if (body.action === 'created') {
    if (!commentSummonsBot(body.comment.body)) {
      logger.debug('context', { context });
      loggingCallback(null, { message: 'the comment didnt summon the cla-bot' });
      return;
    } else {
      if (body.comment.user.login === `${process.env.BOT_NAME}[bot]`) {
        loggingCallback(null, { message: 'the cla-bot summoned itself. Ignored!' });
        return;
      }
      logger.info('The cla-bot has been summoned by a comment');
    }
  }

  logger.info(`Checking CLAs for pull request ${context.gitHubUrls.pullRequest}`);

  Promise.resolve()
    .then(() => {
      // if we are running as an integration, obtain the required integration token
      if (process.env.INTEGRATION_ENABLED && process.env.INTEGRATION_ENABLED === 'true') {
        logger.info('Bot installed as an integration, obtaining installation token');
        return installationToken(context.webhook.installation.id);
      } else {
        logger.info('Bot installed as a webhook, using access token');
        return process.env.GITHUB_ACCESS_TOKEN;
      }
    })
    .then((token) => {
      context.userToken = token;
      logger.info('Attempting to obtain organisation level .clabot file URL');
      return githubRequest(getOrgConfig(context), context.userToken);
    })
    // if the request to obtain the org-level .clabot file returns a non 2xx response
    // (typically 404), this catch block returns a 'token' value that indicates a
    // project level file should be requested
    .catch(() => ({ noOrgConfig }))
    .then((orgConfig) => {
      if ('noOrgConfig' in orgConfig) {
        logger.info('Organisation configuration not found, resolving .clabot URL at project level');
        return githubRequest(getReadmeUrl(context), context.userToken);
      } else {
        logger.info('Organisation configuration found!');
        return orgConfig;
      }
    })
    .then((orgConfig) => {
      logger.info(`Obtaining .clabot configuration file from ${orgConfig.download_url.split('?')[0]}`);
      return githubRequest(getFile(orgConfig), context.userToken);
    })
    .then((config) => {
      if (!is.json(config)) {
        throw new Error('The .clabot file is not valid JSON');
      }
      logger.info('Obtaining the list of commits for the pull request');
      context.config = Object.assign({}, defaultConfig, config);
      return githubRequest(getCommits(context), context.userToken);
    })
    .then((commits) => {
      logger.info(`Total Commits: ${commits.length}, checking CLA status for committers`);
      if (!context.headSha) {
        context.headSha = commits[commits.length - 1].sha;
      }
      const unresolvedLogins = commits.filter(c => c.author == null);
      const unresolvedLoginNames = sortUnique(unresolvedLogins.map(c => c.commit.author.name));
      return {
        unresolved: unresolvedLoginNames,
        commits
      };
    })
    .then((parsedCommits) => {
      if (parsedCommits.unresolved.length > 0) {
        return [null, parsedCommits.unresolved];
      } else {
        const committers = sortUnique(parsedCommits.commits.map(c => c.author.login.toLowerCase()));
        const verifier = contributionVerifier(context.config);
        return Promise.all([verifier(committers, context.userToken), null]);
      }
    })
    .then(([nonContributors, unidentified]) => {
      if (unidentified && unidentified.length > 0) {
        const unidentifiedString = unidentified.map(u => `${u}`).join(', ');
        console.info('INFO', `Some commits from the following contributors are not signed with a validate email address: ${unidentifiedString}. `);
        return githubRequest(addCommentNoEmail(context, unidentifiedString), context.userToken)
          .then(() => githubRequest(deleteLabel(context), context.userToken))
          .then(() => githubRequest(setStatus(context, 'error'), context.userToken))
          .then(() => `CLA has not been signed by users ${unidentifiedString}, added a comment to ${context.gitHubUrls.pullRequest}`);
      } else if (nonContributors && nonContributors.length === 0) {
        console.info('INFO', 'All contributors have a signed CLA, adding success status to the pull request and a label');
        return githubRequest(getLabels(context), context.userToken, 'GET')
          .then((labels) => {
            // check whether this label already exists
            if (!labels.some(l => l.name === context.config.label)) {
              githubRequest(addLabel(context), context.userToken);
            } else {
              logger.info(`The pull request already has the label ${context.config.label}`);
            }
          })
          .then(() => githubRequest(setStatus(context, 'success'), context.userToken))
          .then(() => `added label ${context.config.label} to ${context.gitHubUrls.pullRequest}`);
      } else {
        const usersWithoutCLA = nonContributors.map(contributorId => `@${contributorId}`).join(', ');
        console.info(`The contributors ${usersWithoutCLA} have not signed the CLA, adding error status to the pull request`);
        return githubRequest(addCommentNoCLA(context, usersWithoutCLA), context.userToken)
          .then(() => githubRequest(deleteLabel(context), context.userToken))
          .then(() => githubRequest(setStatus(context, 'error'), context.userToken))
          .then(() => `CLA has not been signed by users ${usersWithoutCLA}, added a comment to ${context.gitHubUrls.pullRequest}`);
      }
    })
    .then(sideEffect(() => {
      if (context.webhook.action === 'created') {
        return githubRequest(addRecheckComment(context), context.userToken);
      }
      return Promise.resolve('');
    }))
    .then(message => loggingCallback(null, { message }))
    .catch((err) => {
      logger.error(err.toString());
      githubRequest(setStatus(context, 'failure'), context.userToken)
        .then(() => loggingCallback(err.toString()));
    });
};

exports.test = {
  commentSummonsBot
};
