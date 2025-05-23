const { exec } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const util = require('util');
const execPromise = util.promisify(exec);
const { sparseCheckout } = require('./sparseCheckout');

const PMD_PATH = process.env.PMD_PATH || '/usr/local/pmd/bin/pmd';

const LANGUAGE_RULESETS = {
    java: 'category/java/bestpractices.xml,category/java/errorprone.xml',
    javascript: 'category/ecmascript/bestpractices.xml,category/ecmascript/errorprone.xml',
    typescript: 'category/ecmascript/bestpractices.xml,category/ecmascript/errorprone.xml',
    php: 'category/php/bestpractices.xml,category/php/errorprone.xml',
    python: 'category/python/bestpractices.xml,category/python/errorprone.xml',
    apex: 'category/apex/bestpractices.xml',
    jsp: 'category/jsp/bestpractices.xml',
    plsql: 'category/plsql/bestpractices.xml',
    xml: 'category/xml/errorprone.xml',
    velocity: 'category/vm/bestpractices.xml'
};

const LANGUAGE_FILE_PATTERNS = {
    java: '*.java',
    javascript: '*.js\n*.jsx',
    typescript: '*.ts\n*.tsx',
    php: '*.php',
    python: '*.py',
    apex: '*.cls\n*.trigger',
    jsp: '*.jsp',
    plsql: '*.sql',
    xml: '*.xml',
    velocity: '*.vm'
};

/**
 * Build the PMD command based on the language and config
 */
function buildPmdCommand(tempDir, rulesets, language) {
    let extensions = '';
    if (language === 'typescript') extensions = '--file-extension ts,tsx';
    else if (language === 'php') extensions = '--file-extension php';

    return `${PMD_PATH} check -d "${tempDir}" -R ${rulesets} -f json ${extensions}`;
}

/**
 * Run PMD analysis on a GitHub repository using sparse checkout to minimize storage use
 * @param {string} repoUrl - URL of the GitHub repository
 * @param {string} language - Language to scan (java, javascript, typescript, php, etc.)
 * @param {string} customRulesets - Optional custom PMD rulesets to use
 * @returns {Promise<Object>} Analysis results
 */
async function scanRepository(repoUrl, language = 'java', customRulesets = null) {

    try {
        if (!await fs.stat(PMD_PATH).catch(() => false)) {
            throw new Error(`PMD not found at: ${PMD_PATH}`);
        }

        const normalizedLanguage = language.toLowerCase();
        const rulesets = customRulesets || LANGUAGE_RULESETS[normalizedLanguage] || LANGUAGE_RULESETS.java;
        const filePattern = LANGUAGE_FILE_PATTERNS[normalizedLanguage] || LANGUAGE_FILE_PATTERNS.java;

        log(`Starting sparse checkout for ${repoUrl} with pattern: ${filePattern}`);
        const { tempDir, files } = await sparseCheckout(repoUrl, filePattern);
        log(`Checked out ${files.length} ${normalizedLanguage} files`);

        if (files.length === 0) {
            log('No relevant files found.');
            return emptyResult();
        }

        const pmdCommand = buildPmdCommand(tempDir, rulesets, normalizedLanguage);
        log(`Running PMD: ${pmdCommand}`);
        const { stdout } = await execPromise(pmdCommand).catch(e => e.stdout ? { stdout: e.stdout } : Promise.reject(e));

        let results = { files: [] };
        try {
            results = JSON.parse(stdout);
        } catch (e) {
            throw new Error(`Failed to parse PMD JSON: ${e.message}`);
        }

        const fileContents = await loadFileContents(tempDir, files);
        const warnings = processWarnings(results, fileContents);
        const summary = generateSummary(warnings);

        await fs.rm(tempDir, { recursive: true, force: true });
        log(`Cleaned up ${tempDir}`);

        return { warnings, summary, fileContents };
    } catch (error) {
        console.error('Scan failed:', error.message);
        throw error;
    }
}

function emptyResult() {
    return {
        warnings: [],
        summary: {
            totalWarnings: 0,
            criticalCount: 0,
            highCount: 0,
            mediumCount: 0,
            lowCount: 0,
            fileCount: 0
        }
    };
}

async function loadFileContents(basePath, files) {
    const contents = {};
    await Promise.all(files.map(async file => {
        try {
            const fullPath = path.join(basePath, file);
            contents[file] = await fs.readFile(fullPath, 'utf8');
        } catch (e) {
            console.warn(`Could not read ${file}:`, e.message);
        }
    }));
    return contents;
}

function processWarnings(results, fileContents) {
    if (!results?.files?.length) return [];

    const warnings = [];
    results.files.forEach(file => {
        const filePath = path.relative('', file.filename);
        const content = fileContents[filePath] || '';
        const lines = content.split('\n');

        (file.violations || []).forEach(violation => {
            const severity = mapPriorityToSeverity(violation.priority);
            const codeSnippet = lines.slice(
                Math.max(0, violation.beginline - 2),
                Math.min(lines.length, violation.endline + 1)
            ).join('\n');

            warnings.push({
                file: filePath,
                line: violation.beginline,
                endLine: violation.endline,
                column: violation.begincolumn,
                endColumn: violation.endcolumn,
                rule: violation.rule,
                ruleset: violation.ruleset,
                severity,
                description: violation.description,
                priority: violation.priority,
                codeSnippet
            });
        });
    });

    return warnings;
}

function mapPriorityToSeverity(priority) {
    switch (priority) {
        case 1: return 'critical';
        case 2: return 'high';
        case 3: return 'medium';
        default: return 'low';
    }
}

function generateSummary(warnings) {
    return {
        totalWarnings: warnings.length,
        criticalCount: warnings.filter(w => w.severity === 'critical').length,
        highCount: warnings.filter(w => w.severity === 'high').length,
        mediumCount: warnings.filter(w => w.severity === 'medium').length,
        lowCount: warnings.filter(w => w.severity === 'low').length,
        fileCount: new Set(warnings.map(w => w.file)).size
    };
}

module.exports = {
    scanRepository,
    LANGUAGE_RULESETS
};
