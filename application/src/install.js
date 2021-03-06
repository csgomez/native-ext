'use strict';

const Path = require('path'), FS = require('fs'), { promisify, } = require('util');
const { chmod, unlink, symlink, readFile, writeFile, } = Object.entries(FS)
.filter(_=> typeof _[1] === 'function' && !_[0].endsWith('Sync'))
.reduce((o, _) => ((o[_[0]] = promisify(_[1])), o), { });
const mkdirp = promisify(require('mkdirp')); // rimraf = promisify(require('rimraf'));
const prepareWrite = (path) => unlink(path).catch(_=>0).then(() => mkdirp(Path.dirname(path))).catch(_=>0);
const replaceFile = (path, data, opt) => prepareWrite(path).then(() => writeFile(path, data, opt));
const replaceLink = (target, path, opt) => prepareWrite(path).then(() => symlink(target, path, opt));

const child_process = require('child_process'), crypto = require('crypto');
const execute = (bin, ...args) => new Promise((resolve, reject) => child_process.execFile(bin, args,
	(error, stdout, stderr) => error ? reject(Object.assign(error, { stderr, stdout, })) : resolve(stdout)
));

const pkg = !!process.versions.pkg, nexe = !!process.__nexe, unpacked = !pkg && !nexe;
const packageJson = require('./package.json'), { version, } = packageJson;
const fullName = packageJson.fullName.replace(/^\W|[^\w.]|\W$/g, '_'); // must match /^\w[\w.]*\w$/
const source = Path.normalize(unpacked ? __dirname : process.argv[0]); // location of packed executable or project root

const nodeOptions = process.argv.find(_=>_.startsWith('--node-options='));
const windows = process.platform === 'win32', linux = process.platform === 'linux', macos = process.platform === 'darwin';
const scriptExt = windows ? '.bat' : '.sh', forwardArgs = windows ? '%*' : '$@';
const installDir = (windows ? process.env.APPDATA +'\\' : require('os').homedir() + (macos ? '/Library/Application Support/' : '/.')) + fullName;

const outPath = (...path) => Path.resolve(installDir, ...path);
const bin = outPath(`bin/${version}/${packageJson.name}`) + (windows && !unpacked ? '.exe' : '');

const script = (...args) => (windows ? '@echo off\r\n\r\n' : '#!/bin/bash\n\n')
+ args.map(s => (/^(?:%[*\d]|[\w/-]+)$/).test(s) ? s : windows ? `"${s}"` : JSON.stringify(s)).join(' ');

async function install() {

	if (!unpacked && source !== bin) { try { (await unlink(bin)); } catch (error) { if (error.code !== 'ENOENT') {
		throw error.code === 'EBUSY' ? new Error(`A file in the installation folder "${ outPath('') }" seems to be open. Please close all browsers and try again.`) : error;
	} } }

	(await Promise.all([

		...(unpacked ? [
			replaceFile(outPath('bin', 'latest'+ scriptExt), script(
				process.argv[0], ...process.execArgv,
				...(nodeOptions ? nodeOptions.slice(15).split(',') : [ ]),
				Path.join(__dirname, 'index.js'), forwardArgs,
			), { mode: '754', }),
		] : [
			source !== bin && copyFile(bin, source).then(() => chmod(bin, '754')),
			readFile(Path.join(__dirname, 'node_modules/ref/build/Release/binding.node'))     .then(data => replaceFile(outPath(bin +'/../res/ref.node'), data)), // copyFile doesn't work
			readFile(Path.join(__dirname, 'node_modules/ffi/build/Release/ffi_bindings.node')).then(data => replaceFile(outPath(bin +'/../res/ffi.node'), data)), // copyFile doesn't work
			replaceFile(outPath('bin', 'latest'+ scriptExt), script(bin, forwardArgs), { mode: '754', }),
		]),

		!windows && writeProfile({ bin, browser: 'chromium', dir: '', }),
		writeProfile({ browser: 'chrome', dir: '', }),
		writeProfile({ browser: 'firefox', dir: '', }),

		// no uninstallation yet
	]));

}

async function writeProfile({ browser, dir, ids, locations, }) {

	const profile = !dir ? browser : crypto.createHash('sha1').update(dir).digest('hex').slice(-16).padStart(16, '0');
	const name = fullName +'.'+ profile;
	const target = outPath('profiles', profile) + Path.sep;

	const defaultIds = browser === 'firefox'
	? [ '@'+ packageJson.name, '@'+ packageJson.name +'-dev', ]
	: [ 'kfabpijabfmojngneeaipepnbnlpkgcf', ];

	ids = Array.from(new Set(Array.isArray(ids) ? defaultIds.concat(ids) : defaultIds));
	locations = typeof locations === 'object' && !Array.isArray(locations) && locations || { };
	unpacked && defaultIds.forEach(id => (locations[id] = Path.resolve(__dirname, '../../extension/build/')));

	const manifest = {
		name, description: `WebExtensions native connector (${browser}: ${dir})`,
		path: target + packageJson.name + scriptExt,
		type: 'stdio', // mandatory
		allowed_extensions: browser === 'firefox' ? ids : undefined,
		allowed_origins: browser !== 'firefox' ? ids.map(id => `chrome-extension://${id}/`) : undefined,
	};
	const config = {
		browser, profile: dir, locations: typeof locations === 'object' && locations || { },
	};

	const link = windows ? (browser === 'firefox'
		? 'HKCU\\Software\\Mozilla\\NativeMessagingHosts\\' : 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\'
	) + name
	: outPath((linux ? {
		chromium: '../.config/chromium/NativeMessagingHosts',
		chrome: '../.config/google-chrome/NativeMessagingHosts',
		firefox: '../.mozilla/native-messaging-hosts',
	} : {
		chromium: '../Chromium/NativeMessagingHosts',
		chrome: '../Google/Chrome/NativeMessagingHosts',
		firefox: '../Mozilla/NativeMessagingHosts',
	})[browser], name +'.json');

	(await Promise.all([

		replaceFile(target +'manifest.json', JSON.stringify(manifest,  null, '\t'), 'utf8'),
		replaceFile(target +'config.json', JSON.stringify(config,  null, '\t'), 'utf8'),
		replaceFile(target + packageJson.name + scriptExt, script(
			outPath('bin', 'latest'+ scriptExt),
			!dir ? 'config' : 'connect',
			target +'config.json',
			forwardArgs,
		), { mode: '754', }),

		windows ? execute('REG', 'ADD', link, '/ve', '/t', 'REG_SZ', '/d', target +'manifest.json', '/f')
		: replaceLink(target +'manifest.json', link),

		replaceFile(target +'unlink'+ scriptExt, script(...(
			windows ? [ 'REG', 'DELETE', link, '/ve', '/f', ] // TODO: delete the entire node, not just the default key
			: [ 'rm', '-f', link, ]
		))),

	]));

	return manifest;
}

module.exports = { install, writeProfile, };

async function copyFile(target, source) { {
	if (source === target) { return; }
	(await mkdirp(Path.dirname(target)).catch(_=>0));
} (await new Promise((resolve, reject) => {
	const read = FS.createReadStream(source), write = FS.createWriteStream(target);
	read.on('error', failed); write.on('error', failed); write.on('finish', resolve);
	function failed(error) { read.destroy(); write.end(); reject(error); }
	read.pipe(write);
})); }
