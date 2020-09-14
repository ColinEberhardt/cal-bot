const requestp = require("./requestAsPromise");
const is = require("is_js");
const { githubRequest, getFile } = require("./githubApi");

// see: https://stackoverflow.com/a/47225591/249933
function partition(array, isValid) {
  return array.reduce(
    ([pass, fail], elem) => {
      return isValid(elem) ? [[...pass, elem], fail] : [pass, [...fail, elem]];
    },
    [[], []]
  );
}

const domainFromEmail = email => "@" + email.split("@")[1];

// return the list of committers who are not know contributors
const contributorArrayVerifier = contributors => committers => {
  const lowerCaseContributors = contributors.map(c => c.toLowerCase());
  // eslint-disable-next-line prettier/prettier
  const [emailVerification, usernameVerification] = partition(
    lowerCaseContributors,
    c => c.includes("@")
  );

  // eslint-disable-next-line prettier/prettier
  const [domainVerification, exactEmailVerification] = partition(
    emailVerification,
    c => c.startsWith("@")
  );

  const isValidContributor = c => {
    if (c.email) {
      if (exactEmailVerification.includes(c.email.toLowerCase())) {
        return true;
      }
      if (domainVerification.includes(domainFromEmail(c.email))) {
        return true;
      }
    }
    if (usernameVerification.includes(c.login.toLowerCase())) {
      return true;
    }
    return false;
  };

  const res = committers.filter(c => !isValidContributor(c)).map(c => c.login);
  return Promise.resolve(res);
};

const configFileFromGithubUrlVerifier = contributorListGithubUrl => (
  committers,
  clabotToken
) =>
  githubRequest(
    {
      url: contributorListGithubUrl,
      method: "GET"
    },
    clabotToken
  )
    .then(body => githubRequest(getFile(body), clabotToken))
    .then(contributors => contributorArrayVerifier(contributors)(committers));

const configFileFromUrlVerifier = contributorListUrl => committers =>
  requestp({
    url: contributorListUrl,
    json: true
  }).then(contributors => contributorArrayVerifier(contributors)(committers));

const webhookVerifier = webhookUrl => committers =>
  Promise.all(
    committers.map(committer =>
      requestp({
        url: webhookUrl + committer.login,
        json: true
      }).then(response => ({
        username: committer.login,
        isContributor: response.isContributor
      }))
    )
  ).then(responses => {
    const contributors = responses
      .filter(r => r.isContributor)
      .map(r => r.username);
    return contributorArrayVerifier(contributors)(committers);
  });

module.exports = config => {
  const configCopy = Object.assign({}, config);

  // handle the 'legacy' configuration where each type had its own propery
  if (configCopy.contributorListGithubUrl) {
    configCopy.contributors = configCopy.contributorListGithubUrl;
  } else if (config.contributorListUrl) {
    configCopy.contributors = configCopy.contributorListUrl;
  } else if (config.contributorWebhook) {
    configCopy.contributors = configCopy.contributorWebhook;
  }

  if (configCopy.contributors) {
    if (is.array(configCopy.contributors)) {
      console.info(
        "INFO",
        "Checking contributors against the list supplied in the .clabot file"
      );
      return contributorArrayVerifier(configCopy.contributors);
    } else if (
      is.url(configCopy.contributors) &&
      configCopy.contributors.indexOf("api.github.com") !== -1
    ) {
      console.info(
        "INFO",
        "Checking contributors against the github URL supplied in the .clabot file"
      );
      return configFileFromGithubUrlVerifier(configCopy.contributors);
    } else if (
      is.url(configCopy.contributors) &&
      configCopy.contributors.indexOf("?") !== -1
    ) {
      console.info(
        "INFO",
        "Checking contributors against the webhook supplied in the .clabot file"
      );
      return webhookVerifier(configCopy.contributors);
    } else if (is.url(configCopy.contributors)) {
      console.info(
        "INFO",
        "Checking contributors against the URL supplied in the .clabot file"
      );
      return configFileFromUrlVerifier(configCopy.contributors);
    }
  }
  throw new Error(
    "A mechanism for verifying contributors has not been specified"
  );
};
