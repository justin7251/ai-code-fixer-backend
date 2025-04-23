const { exec } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const util = require('util');
const execPromise = util.promisify(exec);
const { sparseCheckout } = require('./sparseCheckout');

// Path to the PMD installation
const PMD_PATH = process.env.PMD_PATH || '/usr/local/pmd/bin/pmd';

// Language-specific rulesets mapping
const LANGUAGE_RULESETS = {
    java: 'category/java/bestpractices.xml,category/java/errorprone.xml',
    javascript: 'category/ecmascript/bestpractices.xml,category/ecmascript/errorprone.xml',
    typescript: 'category/ecmascript/bestpractices.xml,category/ecmascript/errorprone.xml', // PMD uses ecmascript for both JS and TS
    php: 'category/php/bestpractices.xml,category/php/errorprone.xml',
    python: 'category/python/bestpractices.xml,category/python/errorprone.xml',
    apex: 'category/apex/bestpractices.xml',
    jsp: 'category/jsp/bestpractices.xml',
    plsql: 'category/plsql/bestpractices.xml',
    xml: 'category/xml/errorprone.xml',
    velocity: 'category/vm/bestpractices.xml'
};

// Language-specific file patterns for sparse checkout
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
 * Run PMD analysis on a GitHub repository using sparse checkout to minimize storage use
 * @param {string} repoUrl - URL of the GitHub repository
 * @param {string} language - Language to scan (java, javascript, typescript, php, etc.)
 * @param {string} customRulesets - Optional custom PMD rulesets to use
 * @returns {Promise<Object>} Analysis results
 */
async function scanRepository(repoUrl, language = 'java', customRulesets = null) {
    try {
        console.log(`Starting PMD scan for ${repoUrl} with language: ${language}`);
        
        // Normalize language to lowercase
        const normalizedLanguage = language.toLowerCase();
        
        // Get appropriate ruleset for the language
        let rulesets;
        if (customRulesets) {
            rulesets = customRulesets;
        } else if (LANGUAGE_RULESETS[normalizedLanguage]) {
            rulesets = LANGUAGE_RULESETS[normalizedLanguage];
        } else {
            // Default to Java if language not supported
            console.log(`Language ${language} not directly supported, defaulting to Java ruleset`);
            rulesets = LANGUAGE_RULESETS.java;
        }
        
        // Get file pattern for sparse checkout
        const filePattern = LANGUAGE_FILE_PATTERNS[normalizedLanguage] || 
                          LANGUAGE_FILE_PATTERNS.java;
        
        // Perform sparse checkout to get only the relevant files
        const { tempDir, files } = await sparseCheckout(repoUrl, filePattern);
        console.log(`Sparse checkout complete. Found ${files.length} ${normalizedLanguage} files`);
        
        if (files.length === 0) {
            console.log(`No ${normalizedLanguage} files found in the repository`);
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
        
        // For TypeScript, we need to ensure we scan .ts files
        let fileExtension = '';
        if (normalizedLanguage === 'typescript') {
            fileExtension = '--file-extension ts,tsx';
        } else if (normalizedLanguage === 'php') {
            fileExtension = '--file-extension php';
        }
        
        // Run PMD
        console.log(`Running PMD scan with ${normalizedLanguage} ruleset: ${rulesets}`);
        const { stdout } = await execPromise(
            `${PMD_PATH} check -d "${tempDir}" -R ${rulesets} -f json ${fileExtension}`
        ).catch(error => {
            if (error.stdout) {
                // PMD might return non-zero exit code even when it produces output
                return { stdout: error.stdout };
            }
            throw error;
        });
        
        console.log('PMD scan completed');
        
        // Parse the results
        let results;
        try {
            results = JSON.parse(stdout);
        } catch (error) {
            console.error('Error parsing PMD results:', error);
            console.log('PMD output:', stdout);
            results = { files: [] };
        }
        
        // Store file contents for potential fixes
        const fileContents = {};
        for (const file of files) {
            try {
                const filePath = path.join(tempDir, file);
                const content = await fs.readFile(filePath, 'utf8');
                fileContents[file] = content;
            } catch (error) {
                console.error(`Error reading file ${file}:`, error);
            }
        }
        
        // Process and categorize warnings
        const warnings = processWarnings(results, fileContents);
        
        // Generate summary
        const summary = generateSummary(warnings);
        
        // Clean up
        await fs.rm(tempDir, { recursive: true, force: true });
        console.log(`Cleaned up temporary directory: ${tempDir}`);
        
        return {
            warnings,
            summary,
            fileContents
        };
    } catch (error) {
        console.error('PMD scanning error:', error);
        throw new Error(`PMD scanning failed: ${error.message}`);
    }
}

/**
 * Process PMD warnings and categorize them
 * @param {Object} results - Raw PMD results
 * @param {Object} fileContents - Contents of the files that were analyzed
 * @returns {Array} Processed warnings
 */
function processWarnings(results, fileContents = {}) {
    // Handle the case where PMD returns no results
    if (!results || !results.files || !Array.isArray(results.files)) {
        return [];
    }
    
    const warnings = [];
    
    // Process each file in the results
    results.files.forEach(file => {
        if (file.violations && Array.isArray(file.violations)) {
            // Extract the file path from the full path in results
            const filePath = file.filename.replace(/^.*[\/\\]/, '');
            const fileContent = fileContents[filePath] || '';
            
            // Get the lines of code if we have the file content
            const lines = fileContent.split('\n');
            
            file.violations.forEach(violation => {
                // Determine severity based on priority
                let severity;
                switch (violation.priority) {
                    case 1:
                        severity = 'critical';
                        break;
                    case 2:
                        severity = 'high';
                        break;
                    case 3:
                        severity = 'medium';
                        break;
                    default:
                        severity = 'low';
                }
                
                // Extract the problematic code segment if we have the file content
                let codeSnippet = '';
                if (lines.length > 0 && violation.beginline > 0 && violation.beginline <= lines.length) {
                    const startLine = Math.max(0, violation.beginline - 2);
                    const endLine = Math.min(lines.length, violation.endline + 2);
                    codeSnippet = lines.slice(startLine - 1, endLine).join('\n');
                }
                
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
        }
    });
    
    return warnings;
}

/**
 * Generate a summary of warnings
 * @param {Array} warnings - Processed warnings
 * @returns {Object} Summary object
 */
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