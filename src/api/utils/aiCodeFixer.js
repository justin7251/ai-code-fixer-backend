const axios = require('axios');
const fs = require('fs');
const path = require('path');

/**
 * AI Code Fixer Utility
 * Uses Google's Gemini API to analyze and fix code issues
 */

// Initialize Google Gemini API configuration
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent';

/**
 * Generate a fix for a code issue using AI
 * @param {Object} issue - The issue to fix
 * @param {string} fileContent - The content of the file with the issue
 * @param {string} language - The programming language
 * @returns {Promise<Object>} The suggested fix
 */
async function generateCodeFix(issue, fileContent, language) {
    try {
        if (!GEMINI_API_KEY) {
            throw new Error('Gemini API not configured. Set GEMINI_API_KEY in environment.');
        }

        // Extract the relevant code section (context around the issue)
        const codeContext = extractCodeContext(fileContent, issue.line, 5);
        
        // Construct the prompt for the AI
        const prompt = constructFixPrompt(issue, codeContext, language);
        
        // Call the Gemini API
        const response = await axios.post(
            `${GEMINI_API_URL}?key=${GEMINI_API_KEY}`,
            {
                contents: [
                    {
                        role: "user",
                        parts: [
                            {
                                text: prompt
                            }
                        ]
                    }
                ],
                generationConfig: {
                    temperature: 0.1,
                    maxOutputTokens: 1000
                }
            },
            {
                headers: {
                    'Content-Type': 'application/json'
                }
            }
        );
        
        // Extract the suggested fix from Gemini response
        const content = response.data.candidates[0]?.content;
        const suggestedFix = content?.parts[0]?.text || '';
        
        // Parse and structure the fix
        return {
            original: codeContext,
            fixed: suggestedFix.trim(),
            issue: issue,
            confidence: calculateConfidence(suggestedFix),
            timestamp: new Date().toISOString()
        };
    } catch (error) {
        console.error('AI code fix error:', error);
        throw new Error(`Failed to generate code fix: ${error.message}`);
    }
}

/**
 * Extract code context around an issue
 * @param {string} fileContent - The file content
 * @param {number} lineNumber - The line number of the issue
 * @param {number} contextLines - Number of lines for context before and after
 * @returns {string} The code context
 */
function extractCodeContext(fileContent, lineNumber, contextLines = 5) {
    const lines = fileContent.split('\n');
    
    const startLine = Math.max(0, lineNumber - contextLines - 1);
    const endLine = Math.min(lines.length - 1, lineNumber + contextLines - 1);
    
    return lines.slice(startLine, endLine + 1).join('\n');
}

/**
 * Construct a prompt for the AI to fix the issue
 * @param {Object} issue - The issue to fix
 * @param {string} codeContext - The code context
 * @param {string} language - The programming language
 * @returns {string} The prompt for the AI
 */
function constructFixPrompt(issue, codeContext, language) {
    const {
        message = 'No description provided',
        rule = 'N/A',
        severity = 'unknown',
        line = '?',
        column
    } = issue;

    return `You are an expert code reviewer and fixer. Your task is to fix code issues without changing functionality. Provide concise, targeted fixes.

Fix the following ${language} code issue:

Issue: ${message}
Rule: ${rule}
Severity: ${severity}
Line ${line}${column != null ? `, Column ${column}` : ''}

Code:
\`\`\`${language}
${codeContext}
\`\`\`

Please provide a fixed version of the code that addresses the issue.
Only include the fixed code snippet, not explanations.
`;
}


/**
 * Calculate confidence score for a suggested fix
 * @param {string} suggestedFix - The suggested fix from the AI
 * @returns {number} Confidence score (0-1)
 */
function calculateConfidence(suggestedFix) {
    // Simple heuristic - could be improved
    if (!suggestedFix || suggestedFix.includes('I cannot fix') || suggestedFix.includes('Unable to fix')) {
        return 0;
    }
    
    // Higher confidence for fixes that are not too different from original
    return 0.8;
}

/**
 * Apply a fix to a file content
 * @param {string} fileContent - Original file content
 * @param {Object} fix - The fix to apply
 * @returns {string} Updated file content
 */
function applyFix(fileContent, fix) {
    try {
        const lines = fileContent.split('\n');
        const startLine = Math.max(0, fix.issue.line - 6);
        const endLine = Math.min(lines.length - 1, fix.issue.line + 4);
        
        // Very simple replacement strategy - in practice you'd need
        // something more sophisticated that handles indentation and only
        // changes what needs to be changed
        const beforeFix = lines.slice(0, startLine).join('\n');
        const afterFix = lines.slice(endLine + 1).join('\n');
        
        return `${beforeFix}\n${fix.fixed}\n${afterFix}`;
    } catch (error) {
        console.error('Error applying fix:', error);
        throw new Error(`Failed to apply fix: ${error.message}`);
    }
}

/**
 * Generate fixes for all issues in a file
 * @param {Array} issues - List of issues to fix
 * @param {string} fileContent - The file content
 * @param {string} language - The programming language
 * @returns {Promise<Array>} List of fixes
 */
async function generateFixesForFile(issues, fileContent, language) {
    const fixes = [];
    
    // Process issues in order of severity
    const sortedIssues = [...issues].sort((a, b) => {
        const severityScore = { 'error': 3, 'warning': 2, 'info': 1 };
        return severityScore[b.severity] - severityScore[a.severity];
    });
    
    for (const issue of sortedIssues) {
        try {
            const fix = await generateCodeFix(issue, fileContent, language);
            fixes.push(fix);
        } catch (error) {
            console.warn(`Skipping fix for issue at line ${issue.line}: ${error.message}`);
        }
    }
    
    return fixes;
}

module.exports = {
    generateCodeFix,
    generateFixesForFile,
    applyFix
};

/**
 * Generates a fix for a code issue and applies it directly to the file.
 * @param {string} localRepoPath - The local path to the repository.
 * @param {string} filePathInRepo - The relative path of the file within the repository.
 * @param {Object} issue - The issue object (expected to have line, message, etc.).
 * @param {string} language - The programming language of the file.
 * @returns {Promise<Object>} An object indicating success or failure and details.
 */
async function generateAndApplyFixInPlace(localRepoPath, filePathInRepo, issue, language) {
    const fullPathToFile = path.join(localRepoPath, filePathInRepo);

    try {
        // Read the current content of the target file
        const originalFileContent = fs.readFileSync(fullPathToFile, 'utf-8');

        // Call generateCodeFix to get the AI-suggested fix
        // generateCodeFix expects the full file content and the issue object
        const fixDetails = await generateCodeFix(issue, originalFileContent, language);

        if (fixDetails && fixDetails.fixed) {
            // Call applyFix to get the updated file content
            // applyFix needs the original content and the fix object (which includes the 'fixed' code string and 'issue' details)
            const updatedContent = applyFix(originalFileContent, fixDetails);

            // Write the updated content back to the file
            fs.writeFileSync(fullPathToFile, updatedContent, 'utf-8');

            return {
                success: true,
                fix: fixDetails.fixed, // The AI generated fix string
                appliedFixContent: updatedContent, // The full content written to the file
                originalContent: originalFileContent,
                filePath: fullPathToFile
            };
        } else {
            return {
                success: false,
                error: 'No fix generated by AI.',
                filePath: fullPathToFile,
                issue: issue
            };
        }
    } catch (error) {
        console.error(`Error in generateAndApplyFixInPlace for ${fullPathToFile}:`, error);
        return {
            success: false,
            error: error.message,
            filePath: fullPathToFile,
            issue: issue
        };
    }
}

module.exports = {
    generateCodeFix,
    generateFixesForFile,
    applyFix,
    generateAndApplyFixInPlace
};
