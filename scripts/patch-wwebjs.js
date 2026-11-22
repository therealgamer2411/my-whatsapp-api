'use strict';

// Local compatibility patch for whatsapp-web.js 1.34.8.
// Upstream references: wwebjs PR #201893, PR #201958, issue #201940.
const fs = require('node:fs');
const path = require('node:path');

const packageRoot = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js');
const clientPath = path.join(packageRoot, 'src', 'Client.js');
const puppeteerPath = path.join(packageRoot, 'src', 'util', 'Puppeteer.js');

function read(file) {
  if (!fs.existsSync(file)) {
    throw new Error('[wwebjs-patch] Expected file not found: ' + file);
  }
  return fs.readFileSync(file, 'utf8');
}

function replaceExactlyOnce(source, original, replacement, label) {
  const first = source.indexOf(original);
  if (first < 0) {
    if (source.includes(label)) return source;
    throw new Error('[wwebjs-patch] Could not locate ' + label + ' in installed source.');
  }
  if (source.indexOf(original, first + original.length) >= 0) {
    throw new Error('[wwebjs-patch] Expected exactly one occurrence of ' + label + '.');
  }
  return source.slice(0, first) + replacement + source.slice(first + original.length);
}

function patchPuppeteerHelper() {
  let source = read(puppeteerPath);
  if (source.includes('async function exposeFunctionWithRetry(')) {
    console.log('[wwebjs-patch] Puppeteer exposeFunction retry already present.');
    return;
  }

  const original = '    await page.exposeFunction(name, fn);\n}\n\nmodule.exports = { exposeFunctionIfAbsent };';
  const replacement = `    await exposeFunctionWithRetry(page, name, fn);
}

async function exposeFunctionWithRetry(page, name, fn, maxAttempts = 5) {
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            if (page.isClosed()) {
                throw new Error('Target closed');
            }
            const exists = await page.evaluate((functionName) => {
                return !!window[functionName];
            }, name);
            if (exists) return;
            await page.exposeFunction(name, fn);
            return;
        } catch (error) {
            lastError = error;
            const message = error && error.message ? error.message : String(error);
            if (
                message.includes(`binding with name ${name}`) &&
                message.includes('already exists')
            ) {
                return;
            }
            const transient = /target closed|detached|destroyed|session closed|execution context/i.test(message);
            if (!transient || attempt === maxAttempts) {
                throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
        }
    }
    throw lastError;
}

module.exports = { exposeFunctionIfAbsent };`;

  source = replaceExactlyOnce(source, original, replacement, 'exposeFunctionIfAbsent implementation');
  fs.writeFileSync(puppeteerPath, source);
  console.log('[wwebjs-patch] Applied transient frame retry to Puppeteer bindings.');
}

function patchClient() {
  let source = read(clientPath);
  if (source.includes('// MF_PATCH_SERIALIZED_INJECT_QUEUE')) {
    console.log('[wwebjs-patch] Client injection patch already present.');
    return;
  }

  source = replaceExactlyOnce(
    source,
    '        this.lastLoggedOut = false;\n',
    '        this.lastLoggedOut = false;\n\n        // MF_PATCH_SERIALIZED_INJECT_QUEUE: serialize reinjection for this page.\n        this._injectQueue = Promise.resolve();\n',
    'client injection queue field'
  );

  const injectPrefix = `    async inject() {
        // Cancel any previous inject still running
        if (this._injectAbort) this._injectAbort.abort();
        const abort = new AbortController();
        this._injectAbort = abort;

        try {`;
  const injectReplacement = `    inject() {
        const injection = this._injectQueue
            .catch(() => undefined)
            .then(() => this._inject());
        this._injectQueue = injection;
        return injection;
    }

    async _inject() {
        const abort = new AbortController();
        this._injectAbort = abort;

        try {`;
  source = replaceExactlyOnce(source, injectPrefix, injectReplacement, 'Client.inject queue wrapper');

  source = replaceExactlyOnce(
    source,
    `                    timeout: authTimeout,
                    signal: abort.signal,`,
    `                    timeout: authTimeout,
                    polling: 200,
                    signal: abort.signal,`,
    'Debug readiness polling option'
  );

  source = replaceExactlyOnce(
    source,
    `                { timeout: authTimeout },
            );`,
    `                { timeout: authTimeout, polling: 200 },
            );`,
    'WhatsApp socket readiness polling option'
  );

  source = replaceExactlyOnce(
    source,
    '                        return this.initialize();',
    '                        return this.initialize({ bypassInjectQueue: true });',
    'authentication recovery queue bypass'
  );

  source = replaceExactlyOnce(
    source,
    '    async initialize() {',
    '    async initialize({ bypassInjectQueue = false } = {}) {',
    'Client.initialize optional queue bypass'
  );

  source = replaceExactlyOnce(
    source,
    `        this._registerFramenavigatedHandler();

        await this.inject();`,
    `        this._registerFramenavigatedHandler();

        if (bypassInjectQueue) {
            await this._inject();
        } else {
            await this.inject();
        }`,
    'Client.initialize serialized injection call'
  );

  const handlerStart = source.indexOf('    _registerFramenavigatedHandler() {');
  const handlerEnd = source.indexOf('    /**\n     * Request authentication via pairing code', handlerStart);
  if (handlerStart < 0 || handlerEnd < 0) {
    throw new Error('[wwebjs-patch] Could not locate framenavigated handler.');
  }

  const handlerReplacement = `    _registerFramenavigatedHandler() {
        if (this._framenavigatedRegistered) return;
        this._framenavigatedRegistered = true;

        this.pupPage.on('framenavigated', (frame) => {
            this._handleFrameNavigated(frame).catch((error) => {
                // EventEmitter does not handle rejected promises from async listeners.
                this.emit('inject_error', error);
            });
        });
    }

    async _handleFrameNavigated(frame) {
        if (frame.parentFrame() !== null) return;

        const isLogout =
            frame.url().includes('post_logout=1') || this.lastLoggedOut;

        if (isLogout) {
            this.emit(Events.DISCONNECTED, 'LOGOUT');
            await this.authStrategy.logout();
            await this.authStrategy.beforeBrowserInitialized();
            await this.authStrategy.afterBrowserInitialized();
            this.lastLoggedOut = false;
        }

        const storeAvailable = await this.pupPage.evaluate(() => {
            return typeof window.WWebJS !== 'undefined';
        });

        if (!isLogout && storeAvailable) return;

        await this.inject();
    }

`;

  source = source.slice(0, handlerStart) + handlerReplacement + source.slice(handlerEnd);
  fs.writeFileSync(clientPath, source);
  console.log('[wwebjs-patch] Applied serialized injection, navigation error handling, and readiness polling.');
}

patchPuppeteerHelper();
patchClient();
console.log('[wwebjs-patch] whatsapp-web.js 1.34.8 compatibility patch complete.');
