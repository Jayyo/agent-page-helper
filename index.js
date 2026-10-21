'use strict';
const fs = require('node:fs');
const path = require('node:path');

const helperPath = path.join(__dirname, 'agent-page-helper.user.js');
let source = null;

module.exports = {
  // Absolute path of the page-side script (for addInitScript({ path })).
  helperPath,
  // Its source, for channels that take a string: page.evaluate, Runtime.evaluate,
  // Page.addScriptToEvaluateOnNewDocument, Selenium execute_script.
  get helperSource() {
    if (source === null) source = fs.readFileSync(helperPath, 'utf8');
    return source;
  },
  globalName: '__aph__',
  version: require('./package.json').version,
};
