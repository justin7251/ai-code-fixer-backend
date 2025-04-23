const express = require('express');
const router = express.Router();
const admin = require('../../../firebase-admin');
const db = admin.firestore();
const { analyzeCode } = require('../utils/staticAnalyzer');
const { generateCodeFix, generateFixesForFile, applyFix } = require('../utils/aiCodeFixer');

// Get supported analysis tools
router.get('/tools', (req, res) => {
    res.json({
        success: true,
        tools: [
            {
                id: 'eslint',
                name: 'ESLint',
                languages: ['javascript', 'typescript'],
                description: 'Static code analysis for JavaScript and TypeScript'
            },
            {
                id: 'pmd',
                name: 'PMD',
                languages: ['java'],
                description: 'Source code analyzer for Java'
            },
            {
                id: 'pylint',
                name: 'PyLint',
                languages: ['python'],
                description: 'Python code analysis tool'
            },
            {
                id: 'phpcs',
                name: 'PHP_CodeSniffer',
                languages: ['php'],
                description: 'PHP code analyzer and formatter'
            }
        ]
    });
});

// Run code analysis on a repository
router.post('/analyze', async (req, res) => {
    try {
        const { repositoryUrl, language, options } = req.body;
        
        if (!repositoryUrl || !language) {
            return res.status(400).json({
                success: false,
                message: 'Repository URL and language are required'
            });
        }
        
        // Send immediate response to indicate analysis has started
        res.status(202).json({
            success: true,
            message: 'Code analysis started',
            repositoryUrl,
            language
        });
        
        // Run analysis asynchronously
        console.log(`Starting code quality analysis for ${repositoryUrl} with language ${language}`);
        
        try {
            // Run the code analysis
            const results = await analyzeCode(repositoryUrl, language, options);
            
            // Save results to database
            const analysisData = {
                repositoryUrl,
                language,
                tool: results.tool,
                userId: req.user?.id,
                summary: results.summary,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            };
            
            // Split issues into a separate collection to handle large datasets
            const issuesCollection = db.collection('code_quality_issues');
            const issuesRef = await issuesCollection.add({
                repositoryUrl,
                issues: results.issues,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
            
            // Add reference to issues collection
            analysisData.issuesRef = issuesRef.id;
            
            // Save the analysis metadata
            const analysisRef = await db.collection('code_quality_analysis').add(analysisData);
            
            console.log(`Code quality analysis saved with ID: ${analysisRef.id}`);
        } catch (error) {
            console.error('Code analysis error:', error);
            // Since we've already sent a response, we can't send another one
            // Log the error for server-side debugging
        }
    } catch (error) {
        console.error('Code analysis request error:', error);
        // This catch only runs if the initial request processing fails
        // If we haven't sent a response yet, send one now
        return res.status(500).json({
            success: false,
            message: 'Failed to start code analysis',
            error: error.message
        });
    }
});

// Run code analysis on a specific repository ID
router.post('/analyze/:repositoryId', async (req, res) => {
    try {
        const repositoryId = req.params.repositoryId;
        const { language, options } = req.body;
        
        // Get repository info from the database
        const repoDoc = await db.collection('repositories').doc(repositoryId).get();
        
        if (!repoDoc.exists) {
            return res.status(404).json({
                success: false,
                message: 'Repository not found'
            });
        }
        
        const repoData = repoDoc.data();
        
        // Check if user has access to this repository
        if (repoData.userId !== req.user?.id) {
            return res.status(403).json({
                success: false,
                message: 'Access denied'
            });
        }
        
        const repositoryUrl = repoData.url || repoData.html_url;
        
        // Detect language if not specified
        let detectedLanguage = language;
        if (!detectedLanguage && repoData.language) {
            detectedLanguage = repoData.language.toLowerCase();
        } else {
            detectedLanguage = 'javascript'; // Default
        }
        
        // Send immediate response
        res.status(202).json({
            success: true,
            message: 'Code analysis started',
            repositoryId,
            language: detectedLanguage
        });
        
        // Run analysis asynchronously
        console.log(`Starting code quality analysis for repository ${repositoryId} with language ${detectedLanguage}`);
        
        try {
            // Run the code analysis
            const results = await analyzeCode(repositoryUrl, detectedLanguage, options);
            
            // Save results to database
            const analysisData = {
                repositoryId,
                repositoryUrl,
                repositoryName: repoData.name,
                language: detectedLanguage,
                tool: results.tool,
                userId: req.user?.id,
                summary: results.summary,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            };
            
            // Split issues into a separate collection to handle large datasets
            const issuesCollection = db.collection('code_quality_issues');
            const issuesRef = await issuesCollection.add({
                repositoryId,
                issues: results.issues,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
            
            // Add reference to issues collection
            analysisData.issuesRef = issuesRef.id;
            
            // Save the analysis metadata
            const analysisRef = await db.collection('code_quality_analysis').add(analysisData);
            
            console.log(`Code quality analysis saved with ID: ${analysisRef.id}`);
        } catch (error) {
            console.error('Code analysis error:', error);
            // Since we've already sent a response, we can't send another one
            // Log the error for server-side debugging
        }
    } catch (error) {
        console.error('Code analysis request error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to start code analysis',
            error: error.message
        });
    }
});

// Get analysis results
router.get('/analysis/:id', async (req, res) => {
    try {
        const analysisId = req.params.id;
        const analysisDoc = await db.collection('code_quality_analysis').doc(analysisId).get();
        
        if (!analysisDoc.exists) {
            return res.status(404).json({
                success: false,
                message: 'Analysis not found'
            });
        }
        
        const analysisData = analysisDoc.data();
        
        // Check if user has access to this analysis
        if (analysisData.userId !== req.user?.id) {
            return res.status(403).json({
                success: false,
                message: 'Access denied'
            });
        }
        
        res.json({
            success: true,
            analysis: analysisData
        });
    } catch (error) {
        console.error('Get analysis error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve analysis',
            error: error.message
        });
    }
});

// Get analysis issues
router.get('/analysis/:id/issues', async (req, res) => {
    try {
        const analysisId = req.params.id;
        const analysisDoc = await db.collection('code_quality_analysis').doc(analysisId).get();
        
        if (!analysisDoc.exists) {
            return res.status(404).json({
                success: false,
                message: 'Analysis not found'
            });
        }
        
        const analysisData = analysisDoc.data();
        
        // Check if user has access to this analysis
        if (analysisData.userId !== req.user?.id) {
            return res.status(403).json({
                success: false,
                message: 'Access denied'
            });
        }
        
        if (!analysisData.issuesRef) {
            return res.status(404).json({
                success: false,
                message: 'No issues found for this analysis'
            });
        }
        
        const issuesDoc = await db.collection('code_quality_issues').doc(analysisData.issuesRef).get();
        
        if (!issuesDoc.exists) {
            return res.status(404).json({
                success: false,
                message: 'Issues not found'
            });
        }
        
        // Support pagination
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 100;
        const startIndex = (page - 1) * limit;
        
        const issues = issuesDoc.data().issues || [];
        const paginatedIssues = issues.slice(startIndex, startIndex + limit);
        
        res.json({
            success: true,
            issues: paginatedIssues,
            pagination: {
                total: issues.length,
                page,
                limit,
                pages: Math.ceil(issues.length / limit)
            }
        });
    } catch (error) {
        console.error('Get issues error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve issues',
            error: error.message
        });
    }
});

// Get all analyses for a repository
router.get('/repository/:repositoryId', async (req, res) => {
    try {
        const repositoryId = req.params.repositoryId;
        
        const analysesSnapshot = await db.collection('code_quality_analysis')
            .where('repositoryId', '==', repositoryId)
            .where('userId', '==', req.user?.id)
            .orderBy('createdAt', 'desc')
            .get();
            
        const analyses = [];
        analysesSnapshot.forEach(doc => {
            analyses.push({
                id: doc.id,
                ...doc.data()
            });
        });
        
        res.json({
            success: true,
            analyses
        });
    } catch (error) {
        console.error('Get repository analyses error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve analyses for repository',
            error: error.message
        });
    }
});

// Generate HTML report for analysis
router.get('/analysis/:id/report', async (req, res) => {
    try {
        const analysisId = req.params.id;
        const analysisDoc = await db.collection('code_quality_analysis').doc(analysisId).get();
        
        if (!analysisDoc.exists) {
            return res.status(404).json({
                success: false,
                message: 'Analysis not found'
            });
        }
        
        const analysisData = analysisDoc.data();
        
        // Check if user has access to this analysis
        if (analysisData.userId !== req.user?.id) {
            return res.status(403).json({
                success: false,
                message: 'Access denied'
            });
        }
        
        if (!analysisData.issuesRef) {
            return res.status(404).json({
                success: false,
                message: 'No issues found for this analysis'
            });
        }
        
        const issuesDoc = await db.collection('code_quality_issues').doc(analysisData.issuesRef).get();
        
        if (!issuesDoc.exists) {
            return res.status(404).json({
                success: false,
                message: 'Issues not found'
            });
        }
        
        const issues = issuesDoc.data().issues || [];
        
        // Generate HTML report
        const html = generateHtmlReport(analysisData, issues);
        
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
    } catch (error) {
        console.error('Generate report error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to generate report',
            error: error.message
        });
    }
});

// Get the content of a specific file
router.get('/analysis/:id/file/:filePath(*)', async (req, res) => {
    try {
        const analysisId = req.params.id;
        const filePath = req.params.filePath;
        
        const analysisDoc = await db.collection('code_quality_analysis').doc(analysisId).get();
        
        if (!analysisDoc.exists) {
            return res.status(404).json({
                success: false,
                message: 'Analysis not found'
            });
        }
        
        const analysisData = analysisDoc.data();
        
        // Check if user has access to this analysis
        if (analysisData.userId !== req.user?.id) {
            return res.status(403).json({
                success: false,
                message: 'Access denied'
            });
        }
        
        // Get file content from the issues document
        if (!analysisData.issuesRef) {
            return res.status(404).json({
                success: false,
                message: 'No issues data found for this analysis'
            });
        }
        
        const issuesDoc = await db.collection('code_quality_issues').doc(analysisData.issuesRef).get();
        
        if (!issuesDoc.exists) {
            return res.status(404).json({
                success: false,
                message: 'Issues data not found'
            });
        }
        
        const issuesData = issuesDoc.data();
        
        // Check if file content is stored
        if (!issuesData.fileContents || !issuesData.fileContents[filePath]) {
            return res.status(404).json({
                success: false,
                message: `File '${filePath}' not found in analysis data`
            });
        }
        
        res.json({
            success: true,
            file: {
                path: filePath,
                content: issuesData.fileContents[filePath]
            }
        });
    } catch (error) {
        console.error('Get file error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve file',
            error: error.message
        });
    }
});

// Generate AI fix for a specific issue
router.post('/fix-issue', async (req, res) => {
    try {
        const { issue, fileContent, language } = req.body;
        
        if (!issue || !fileContent || !language) {
            return res.status(400).json({
                success: false,
                message: 'Issue details, file content, and language are required'
            });
        }
        
        // Generate fix
        const fix = await generateCodeFix(issue, fileContent, language);
        
        // Apply the fix to get updated content
        const updatedContent = applyFix(fileContent, fix);
        
        res.json({
            success: true,
            fix,
            updatedContent
        });
    } catch (error) {
        console.error('Generate fix error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to generate fix',
            error: error.message
        });
    }
});

// Generate AI fixes for all issues in a file
router.post('/fix-file', async (req, res) => {
    try {
        const { issues, fileContent, language } = req.body;
        
        if (!issues || !issues.length || !fileContent || !language) {
            return res.status(400).json({
                success: false,
                message: 'Issues array, file content, and language are required'
            });
        }
        
        // Limit the number of issues to fix to avoid timeouts
        const issuesToFix = issues.slice(0, 5);
        
        // Generate fixes
        const fixes = await generateFixesForFile(issuesToFix, fileContent, language);
        
        // Apply fixes one by one
        let currentContent = fileContent;
        for (const fix of fixes) {
            if (fix.confidence > 0.5) {
                currentContent = applyFix(currentContent, fix);
            }
        }
        
        res.json({
            success: true,
            fixes,
            fixedCount: fixes.length,
            totalIssues: issues.length,
            updatedContent: currentContent
        });
    } catch (error) {
        console.error('Generate fixes error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to generate fixes',
            error: error.message
        });
    }
});

// Save fixed file
router.post('/save-fix', async (req, res) => {
    try {
        const { analysisId, filePath, originalContent, fixedContent, fixes } = req.body;
        
        if (!analysisId || !filePath || !fixedContent) {
            return res.status(400).json({
                success: false,
                message: 'Analysis ID, file path, and fixed content are required'
            });
        }
        
        const analysisDoc = await db.collection('code_quality_analysis').doc(analysisId).get();
        
        if (!analysisDoc.exists) {
            return res.status(404).json({
                success: false,
                message: 'Analysis not found'
            });
        }
        
        const analysisData = analysisDoc.data();
        
        // Check if user has access to this analysis
        if (analysisData.userId !== req.user?.id) {
            return res.status(403).json({
                success: false,
                message: 'Access denied'
            });
        }
        
        // Save the fix to the database
        const fixData = {
            analysisId,
            filePath,
            fixes: fixes || [],
            originalContent,
            fixedContent,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            userId: req.user?.id
        };
        
        const fixRef = await db.collection('code_fixes').add(fixData);
        
        res.json({
            success: true,
            fixId: fixRef.id,
            message: 'Fix saved successfully'
        });
    } catch (error) {
        console.error('Save fix error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to save fix',
            error: error.message
        });
    }
});

// Helper function to generate HTML report
function generateHtmlReport(analysisData, issues) {
    // Group issues by file
    const fileMap = {};
    
    issues.forEach(issue => {
        if (!fileMap[issue.file]) {
            fileMap[issue.file] = [];
        }
        fileMap[issue.file].push(issue);
    });
    
    // Sort files by issue count (descending)
    const sortedFiles = Object.entries(fileMap)
        .sort((a, b) => b[1].length - a[1].length);
    
    // Generate file list HTML
    let fileListHtml = '';
    for (const [filename, fileIssues] of sortedFiles) {
        const fileHtml = `
            <div class="file-item">
                <div class="file-header">
                    <div class="file-path">${filename}</div>
                    <div class="file-count">${fileIssues.length} issues</div>
                </div>
                <ul class="file-warnings">
                    ${fileIssues.map(issue => `
                        <li class="warning-item ${issue.severity}">
                            <div class="warning-header">
                                <span class="warning-rule">${issue.rule}</span>
                                <span class="warning-location">Line ${issue.line}${issue.column ? `, Column ${issue.column}` : ''}</span>
                            </div>
                            <div class="warning-description">${issue.message}</div>
                            <div class="warning-meta">
                                Severity: <strong>${issue.severity}</strong>
                            </div>
                        </li>
                    `).join('')}
                </ul>
            </div>
        `;
        
        fileListHtml += fileHtml;
    }
    
    // Create HTML report
    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Code Quality Report - ${analysisData.repositoryName || analysisData.repositoryUrl}</title>
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif; line-height: 1.6; color: #333; max-width: 1200px; margin: 0 auto; padding: 20px; }
            h1, h2, h3 { color: #2c3e50; }
            .summary { background-color: #f8f9fa; border-radius: 4px; padding: 15px; margin-bottom: 20px; }
            .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; }
            .summary-item { border-radius: 4px; padding: 15px; text-align: center; }
            .error, .critical, .high { background-color: #ffebee; border-left: 5px solid #f44336; }
            .warning, .medium { background-color: #fff8e1; border-left: 5px solid #ff9800; }
            .info, .low { background-color: #e3f2fd; border-left: 5px solid #2196f3; }
            .file-item { margin-bottom: 30px; border: 1px solid #e0e0e0; border-radius: 4px; overflow: hidden; }
            .file-header { background-color: #f5f5f5; padding: 10px 15px; font-weight: bold; cursor: pointer; display: flex; justify-content: space-between; }
            .file-path { font-family: monospace; overflow: hidden; text-overflow: ellipsis; }
            .file-warnings { padding: 0; margin: 0; list-style: none; display: none; }
            .file-warnings.active { display: block; }
            .warning-item { padding: 10px 15px; border-top: 1px solid #e0e0e0; }
            .warning-header { display: flex; justify-content: space-between; font-weight: bold; margin-bottom: 5px; }
            .warning-location { font-family: monospace; color: #607d8b; }
            .warning-rule { color: #7986cb; }
            .warning-description { margin-top: 5px; margin-bottom: 10px; }
            .repo-info { margin-bottom: 20px; }
            .filters { margin-bottom: 20px; display: flex; gap: 10px; flex-wrap: wrap; }
            .filter-group { display: flex; align-items: center; }
            .filter-group label { margin-right: 5px; }
            .search { padding: 8px; border: 1px solid #ddd; border-radius: 4px; width: 300px; }
            @media (max-width: 768px) {
                .summary-grid { grid-template-columns: 1fr; }
            }
        </style>
    </head>
    <body>
        <h1>Code Quality Report</h1>
        
        <div class="repo-info">
            <h2>${analysisData.repositoryName || analysisData.repositoryUrl}</h2>
            <p>Language: ${analysisData.language || 'Unknown'}</p>
            <p>Tool: ${analysisData.tool || 'Unknown'}</p>
            <p>Analysis Date: ${new Date(analysisData.createdAt?.toDate() || Date.now()).toLocaleString()}</p>
        </div>
        
        <div class="summary">
            <h3>Summary</h3>
            <div class="summary-grid">
                <div class="summary-item error">
                    <h4>Errors</h4>
                    <div class="count">${analysisData.summary?.errorCount || 0}</div>
                </div>
                <div class="summary-item warning">
                    <h4>Warnings</h4>
                    <div class="count">${analysisData.summary?.warningCount || 0}</div>
                </div>
                <div class="summary-item">
                    <h4>Files Analyzed</h4>
                    <div class="count">${analysisData.summary?.fileCount || 0}</div>
                </div>
                <div class="summary-item">
                    <h4>Total Issues</h4>
                    <div class="count">${(analysisData.summary?.errorCount || 0) + (analysisData.summary?.warningCount || 0)}</div>
                </div>
            </div>
        </div>
        
        <div class="filters">
            <div class="filter-group">
                <input type="text" class="search" id="searchInput" placeholder="Search for files, rules, or text...">
            </div>
            <div class="filter-group">
                <label for="severityFilter">Severity:</label>
                <select id="severityFilter">
                    <option value="all">All</option>
                    <option value="error">Error</option>
                    <option value="warning">Warning</option>
                    <option value="info">Info</option>
                </select>
            </div>
        </div>
        
        <div id="fileList">
            ${fileListHtml}
        </div>
        
        <script>
            // Toggle file warnings visibility
            document.querySelectorAll('.file-header').forEach(header => {
                header.addEventListener('click', () => {
                    const warnings = header.nextElementSibling;
                    warnings.classList.toggle('active');
                });
            });
            
            // Filter functionality
            const searchInput = document.getElementById('searchInput');
            const severityFilter = document.getElementById('severityFilter');
            const fileItems = document.querySelectorAll('.file-item');
            
            function applyFilters() {
                const searchTerm = searchInput.value.toLowerCase();
                const severityValue = severityFilter.value;
                
                fileItems.forEach(fileItem => {
                    const fileText = fileItem.textContent.toLowerCase();
                    const hasSearchMatch = searchTerm === '' || fileText.includes(searchTerm);
                    
                    let showFile = hasSearchMatch;
                    
                    // Apply severity filter
                    if (severityValue !== 'all' && showFile) {
                        const warningItems = fileItem.querySelectorAll('.warning-item');
                        const hasSeverityMatch = Array.from(warningItems).some(
                            item => item.classList.contains(severityValue)
                        );
                        showFile = hasSeverityMatch;
                        
                        // Show only matching warnings
                        warningItems.forEach(item => {
                            item.style.display = 
                                (severityValue === 'all' || item.classList.contains(severityValue)) &&
                                (searchTerm === '' || item.textContent.toLowerCase().includes(searchTerm))
                                ? 'block' : 'none';
                        });
                    }
                    
                    fileItem.style.display = showFile ? 'block' : 'none';
                });
            }
            
            searchInput.addEventListener('input', applyFilters);
            severityFilter.addEventListener('change', applyFilters);
        </script>
    </body>
    </html>
    `;
}

module.exports = router; 