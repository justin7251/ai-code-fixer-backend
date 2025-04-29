const express = require('express');
const router = express.Router();
const admin = require('../../../firebase-admin');
const db = admin.firestore();
const { scanRepository, LANGUAGE_RULESETS } = require('../utils/pmdScanner');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const xml2js = require('xml2js');
const axios = require('axios');
const auth = require('../middlewares/auth');

// Middleware to handle JSON parsing errors
router.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.error('JSON Parse Error:', err.message);
    return res.status(400).json({ 
      success: false, 
      error: 'Bad Request',
      message: 'Invalid JSON in request body' 
    });
  }
  next(err);
});

// Get supported languages
router.get('/languages', auth, (req, res) => {
    try {
        const supportedLanguages = Object.keys(LANGUAGE_RULESETS);
        
        res.json({
            success: true,
            languages: supportedLanguages
        });
    } catch (error) {
        console.error('Get languages error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve supported languages',
            error: error.message
        });
    }
});

// Generate PMD rules from docs 
router.get('/rules/:language', auth, async (req, res) => {
    try {
        const language = req.params.language.toLowerCase();
        
        if (!LANGUAGE_RULESETS[language]) {
            return res.status(400).json({
                success: false,
                message: `Unsupported language: ${language}`
            });
        }
        
        // Map language to PMD documentation URL
        let docUrl;
        if (language === 'typescript') {
            // TypeScript uses the ECMAScript rules
            docUrl = 'https://docs.pmd-code.org/latest/pmd_rules_ecmascript.html';
        } else {
            docUrl = `https://docs.pmd-code.org/latest/pmd_rules_${language}.html`;
        }
        
        try {
            // Fetch the documentation
            const response = await axios.get(docUrl);
            
            res.json({
                success: true,
                language,
                docsUrl: docUrl,
                rulesets: LANGUAGE_RULESETS[language].split(',')
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: `Failed to fetch rules for ${language}`,
                error: error.message
            });
        }
    } catch (error) {
        console.error('Get rules error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve rules',
            error: error.message
        });
    }
});

// Get all analyses for a repository - MUST come before /:id route
router.get('/repository/:repositoryId', auth, async (req, res) => {
    try {
        const repositoryId = req.params.repositoryId;
        const analysesSnapshot = await db.collection('analysis')
            .where('repositoryId', '==', repositoryId)
            .where('userId', '==', req.user.id)
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

// Generate PMD report in different formats
router.get('/:id/report/:format', auth, async (req, res) => {
    try {
        const analysisId = req.params.id;
        const format = req.params.format.toLowerCase();
        const validFormats = ['html', 'xml', 'checkstyle', 'json', 'csv'];
        
        if (!validFormats.includes(format)) {
            return res.status(400).json({
                success: false,
                message: `Unsupported format. Supported formats are: ${validFormats.join(', ')}`
            });
        }
        
        // Get analysis data
        const analysisDoc = await db.collection('analysis').doc(analysisId).get();
        
        if (!analysisDoc.exists) {
            return res.status(404).json({
                success: false,
                message: 'Analysis not found'
            });
        }
        
        const analysisData = analysisDoc.data();
        
        // Check if user has access to this analysis
        if (analysisData.userId !== req.user.id) {
            return res.status(403).json({
                success: false,
                message: 'Access denied'
            });
        }
        
        // Get warnings data
        if (!analysisData.warningsRef) {
            return res.status(404).json({
                success: false,
                message: 'No warnings found for this analysis'
            });
        }
        
        const warningsDoc = await db.collection('analysis_warnings').doc(analysisData.warningsRef).get();
        
        if (!warningsDoc.exists) {
            return res.status(404).json({
                success: false,
                message: 'Warnings not found'
            });
        }
        
        const warnings = warningsDoc.data().warnings || [];
        
        // Generate report based on format
        switch (format) {
            case 'json':
                return res.json({
                    success: true,
                    report: {
                        analysis: analysisData,
                        warnings
                    }
                });
                
            case 'xml':
                // Generate PMD-style XML
                const pmdXml = generatePmdXml(warnings, analysisData);
                res.setHeader('Content-Type', 'application/xml');
                res.setHeader('Content-Disposition', `attachment; filename="pmd-report-${analysisId}.xml"`);
                return res.send(pmdXml);
                
            case 'checkstyle':
                // Generate CheckStyle-compatible XML
                const checkstyleXml = generateCheckstyleXml(warnings, analysisData);
                res.setHeader('Content-Type', 'application/xml');
                res.setHeader('Content-Disposition', `attachment; filename="checkstyle-report-${analysisId}.xml"`);
                return res.send(checkstyleXml);
                
            case 'csv':
                // Generate CSV
                const csv = generateCsv(warnings, analysisData);
                res.setHeader('Content-Type', 'text/csv');
                res.setHeader('Content-Disposition', `attachment; filename="pmd-report-${analysisId}.csv"`);
                return res.send(csv);
                
            case 'html':
                // Generate HTML report
                const html = await generateHtmlReport(warnings, analysisData);
                res.setHeader('Content-Type', 'text/html');
                return res.send(html);
        }
    } catch (error) {
        console.error('Generate report error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to generate report',
            error: error.message
        });
    }
});

// Helper function to generate PMD XML
function generatePmdXml(warnings, analysisData) {
    const builder = new xml2js.Builder({ 
        rootName: 'pmd',
        xmldec: { version: '1.0', encoding: 'UTF-8' }
    });
    
    // Group warnings by file
    const fileMap = {};
    
    warnings.forEach(warning => {
        if (!fileMap[warning.file]) {
            fileMap[warning.file] = [];
        }
        fileMap[warning.file].push(warning);
    });
    
    // Build PMD XML structure
    const pmdData = {
        $: {
            version: '6.0.0',
            timestamp: new Date().toISOString(),
            'analysis-id': analysisData.repositoryId
        },
        file: []
    };
    
    // Add files and violations
    for (const [filename, fileWarnings] of Object.entries(fileMap)) {
        const fileData = {
            $: { name: filename },
            violation: fileWarnings.map(warning => ({
                $: {
                    beginline: warning.line,
                    endline: warning.endLine || warning.line,
                    begincolumn: warning.column || '1',
                    endcolumn: warning.endColumn || '1',
                    rule: warning.rule,
                    ruleset: warning.ruleset,
                    priority: warning.priority || '3',
                    externalInfoUrl: `https://docs.pmd-code.org/latest/pmd_rules_${analysisData.language}_${warning.ruleset.split('/').pop().replace('.xml', '')}.html#${warning.rule.toLowerCase()}`
                },
                _: warning.description
            }))
        };
        
        pmdData.file.push(fileData);
    }
    
    return builder.buildObject(pmdData);
}

// Helper function to generate CheckStyle XML
function generateCheckstyleXml(warnings, analysisData) {
    const builder = new xml2js.Builder({ 
        rootName: 'checkstyle',
        xmldec: { version: '1.0', encoding: 'UTF-8' }
    });
    
    // Group warnings by file
    const fileMap = {};
    
    warnings.forEach(warning => {
        if (!fileMap[warning.file]) {
            fileMap[warning.file] = [];
        }
        fileMap[warning.file].push(warning);
    });
    
    // Build CheckStyle XML structure
    const checkstyleData = {
        $: {
            version: '8.0'
        },
        file: []
    };
    
    // Map PMD severity to CheckStyle severity
    const severityMap = {
        'critical': 'error',
        'high': 'error',
        'medium': 'warning',
        'low': 'info'
    };
    
    // Add files and errors
    for (const [filename, fileWarnings] of Object.entries(fileMap)) {
        const fileData = {
            $: { name: filename },
            error: fileWarnings.map(warning => ({
                $: {
                    line: warning.line,
                    column: warning.column || '1',
                    severity: severityMap[warning.severity] || 'warning',
                    message: warning.description,
                    source: `PMD.${warning.ruleset}.${warning.rule}`
                }
            }))
        };
        
        checkstyleData.file.push(fileData);
    }
    
    return builder.buildObject(checkstyleData);
}

// Helper function to generate CSV
function generateCsv(warnings, analysisData) {
    const headers = ['File', 'Line', 'Column', 'Rule', 'Ruleset', 'Priority', 'Severity', 'Description'];
    const rows = warnings.map(warning => [
        warning.file,
        warning.line,
        warning.column || '',
        warning.rule,
        warning.ruleset,
        warning.priority || '',
        warning.severity,
        `"${warning.description.replace(/"/g, '""')}"`
    ]);
    
    const csvContent = [
        headers.join(','),
        ...rows.map(row => row.join(','))
    ].join('\n');
    
    return csvContent;
}

// Helper function to generate HTML report
async function generateHtmlReport(warnings, analysisData) {
    // Create a simple but effective HTML template
    const template = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>PMD Analysis Report - ${analysisData.repositoryName}</title>
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif; line-height: 1.6; color: #333; max-width: 1200px; margin: 0 auto; padding: 20px; }
            h1, h2, h3 { color: #2c3e50; }
            .summary { background-color: #f8f9fa; border-radius: 4px; padding: 15px; margin-bottom: 20px; }
            .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; }
            .summary-item { border-radius: 4px; padding: 15px; text-align: center; }
            .critical { background-color: #ffebee; border-left: 5px solid #f44336; }
            .high { background-color: #fff8e1; border-left: 5px solid #ff9800; }
            .medium { background-color: #e8f5e9; border-left: 5px solid #4caf50; }
            .low { background-color: #e3f2fd; border-left: 5px solid #2196f3; }
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
        <h1>PMD Analysis Report</h1>
        
        <div class="repo-info">
            <h2>${analysisData.repositoryName}</h2>
            <p>Language: ${analysisData.language || 'Unknown'}</p>
            <p>Analysis Date: ${new Date(analysisData.createdAt?.toDate() || Date.now()).toLocaleString()}</p>
        </div>
        
        <div class="summary">
            <h3>Summary</h3>
            <div class="summary-grid">
                <div class="summary-item critical">
                    <h4>Critical</h4>
                    <div class="count">${analysisData.summary?.criticalCount || 0}</div>
                </div>
                <div class="summary-item high">
                    <h4>High</h4>
                    <div class="count">${analysisData.summary?.highCount || 0}</div>
                </div>
                <div class="summary-item medium">
                    <h4>Medium</h4>
                    <div class="count">${analysisData.summary?.mediumCount || 0}</div>
                </div>
                <div class="summary-item low">
                    <h4>Low</h4>
                    <div class="count">${analysisData.summary?.lowCount || 0}</div>
                </div>
                <div class="summary-item">
                    <h4>Total Files</h4>
                    <div class="count">${analysisData.summary?.fileCount || 0}</div>
                </div>
                <div class="summary-item">
                    <h4>Total Warnings</h4>
                    <div class="count">${analysisData.summary?.totalWarnings || 0}</div>
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
                    <option value="critical">Critical</option>
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                </select>
            </div>
        </div>
        
        <div id="fileList">
            ${generateFileListHtml(warnings)}
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
    
    return template;
}

// Helper function to generate HTML for file list
function generateFileListHtml(warnings) {
    // Group warnings by file
    const fileMap = {};
    
    warnings.forEach(warning => {
        if (!fileMap[warning.file]) {
            fileMap[warning.file] = [];
        }
        fileMap[warning.file].push(warning);
    });
    
    let html = '';
    
    // Sort files by warning count (descending)
    const sortedFiles = Object.entries(fileMap)
        .sort((a, b) => b[1].length - a[1].length);
    
    for (const [filename, fileWarnings] of sortedFiles) {
        const fileHtml = `
            <div class="file-item">
                <div class="file-header">
                    <div class="file-path">${filename}</div>
                    <div class="file-count">${fileWarnings.length} issues</div>
                </div>
                <ul class="file-warnings">
                    ${fileWarnings.map(warning => `
                        <li class="warning-item ${warning.severity}">
                            <div class="warning-header">
                                <span class="warning-rule">${warning.rule}</span>
                                <span class="warning-location">Line ${warning.line}${warning.column ? `, Column ${warning.column}` : ''}</span>
                            </div>
                            <div class="warning-description">${warning.description}</div>
                            <div class="warning-meta">
                                Severity: <strong>${warning.severity}</strong> | 
                                Priority: ${warning.priority || 'N/A'} | 
                                Ruleset: ${warning.ruleset}
                            </div>
                        </li>
                    `).join('')}
                </ul>
            </div>
        `;
        
        html += fileHtml;
    }
    
    return html;
}

// Get detailed warnings for an analysis
router.get('/:id/warnings', auth, async (req, res) => {
    try {
        const analysisId = req.params.id;
        const analysisDoc = await db.collection('analysis').doc(analysisId).get();
        
        if (!analysisDoc.exists) {
            return res.status(404).json({
                success: false,
                message: 'Analysis not found'
            });
        }
        
        const analysisData = analysisDoc.data();
        
        // Check if user has access to this analysis
        if (analysisData.userId !== req.user.id) {
            return res.status(403).json({
                success: false,
                message: 'Access denied'
            });
        }
        
        if (!analysisData.warningsRef) {
            return res.status(404).json({
                success: false,
                message: 'No warnings found for this analysis'
            });
        }
        
        const warningsDoc = await db.collection('analysis_warnings').doc(analysisData.warningsRef).get();
        
        if (!warningsDoc.exists) {
            return res.status(404).json({
                success: false,
                message: 'Warnings not found'
            });
        }
        
        res.json({
            success: true,
            warnings: warningsDoc.data().warnings || []
        });
    } catch (error) {
        console.error('Get warnings error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve warnings',
            error: error.message
        });
    }
});

// Get file content from analysis
router.get('/:id/file/:file', auth, async (req, res) => {
    try {
        const analysisId = req.params.id;
        const filePath = req.params.file;
        
        console.log(`[DEBUG] Fetching file ${filePath} for analysis ${analysisId}`);
        
        // Get the analysis from Firestore
        const analysisDoc = await db.collection('analysis').doc(analysisId).get();
        
        if (!analysisDoc.exists) {
            console.log(`[DEBUG] Analysis ${analysisId} not found`);
            return res.status(404).json({
                success: false,
                message: 'Analysis not found'
            });
        }
        
        const analysisData = analysisDoc.data();
        
        // Check if user has access to this analysis
        if (analysisData.userId !== req.user?.id) {
            console.log(`[DEBUG] Access denied: userId ${req.user?.id} doesn't match analysis owner ${analysisData.userId}`);
            return res.status(403).json({
                success: false,
                message: 'Access denied'
            });
        }
        
        // Get warnings data which contains file contents
        if (!analysisData.warningsRef) {
            console.log(`[DEBUG] No warnings reference found for analysis ${analysisId}`);
            return res.status(404).json({
                success: false, 
                message: 'No file contents found for this analysis'
            });
        }
        
        const warningsDoc = await db.collection('analysis_warnings').doc(analysisData.warningsRef).get();
        
        if (!warningsDoc.exists) {
            console.log(`[DEBUG] Warnings document ${analysisData.warningsRef} not found`);
            return res.status(404).json({
                success: false,
                message: 'Analysis data not found'
            });
        }
        
        const warningsData = warningsDoc.data();
        
        // Check if the warnings document has file contents
        if (!warningsData.fileContents || !warningsData.fileContents[filePath]) {
            console.log(`[DEBUG] File ${filePath} not found in stored contents, attempting to fetch from GitHub`);
            
            try {
                // If not found in stored results, fetch the file from GitHub
                const { fetchSingleFile } = require('../utils/sparseCheckout');
                const content = await fetchSingleFile(analysisData.repositoryUrl, filePath);
                
                return res.json({
                    success: true,
                    file: {
                        path: filePath,
                        content: content
                    }
                });
            } catch (fetchError) {
                console.error(`[ERROR] Failed to fetch file from GitHub: ${fetchError.message}`);
                return res.status(404).json({
                    success: false,
                    message: `File not found: ${filePath}`,
                    error: fetchError.message
                });
            }
        }
        
        // Return the file content from the warnings document
        return res.json({
            success: true,
            file: {
                path: filePath,
                content: warningsData.fileContents[filePath]
            }
        });
        
    } catch (error) {
        console.error(`[ERROR] Error getting file content: ${error.message}`);
        res.status(500).json({ 
            success: false,
            message: 'Error getting file content', 
            error: error.message 
        });
    }
});

// Get analysis by ID (keep this after more specific /:id/... routes)
router.get('/:id', auth, async (req, res) => {
    try {
        const analysisId = req.params.id;
        console.log(`[DEBUG] Fetching analysis with ID: ${analysisId}`);
        
        const analysisDoc = await db.collection('analysis').doc(analysisId).get();
        
        if (!analysisDoc.exists) {
            console.log(`[DEBUG] Analysis ${analysisId} not found`);
            return res.status(404).json({
                success: false,
                message: 'Analysis not found'
            });
        }
        
        const analysisData = analysisDoc.data();
        
        // Check if user has access to this analysis
        if (analysisData.userId !== req.user.id) {
            console.log(`[DEBUG] Access denied: userId ${req.user.id} doesn't match analysis owner ${analysisData.userId}`);
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
        console.error('[ERROR] Get analysis error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve analysis',
            error: error.message
        });
    }
});

// Create a new analysis with repository information
router.post('/', async (req, res) => {
    try {
        const { repositoryId, repositoryName, userId, repositoryUrl, language, customRulesets } = req.body;
        
        if (!repositoryId || !repositoryName || !userId || !repositoryUrl) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields'
            });
        }
        
        // Send immediate response to indicate the analysis has started
        res.status(202).json({
            success: true,
            message: 'Analysis started',
            repositoryId,
            language: language || 'java'
        });
        
        // Run the PMD scan asynchronously
        console.log(`Starting analysis for repository ${repositoryId} with language ${language || 'java'}`);
        
        // Run PMD scan
        const analysis = await scanRepository(
            repositoryUrl, 
            language || 'java',
            customRulesets
        );
        
        console.log(`PMD scan completed for repository ${repositoryId}`);
        
        // Create a separate document for detailed warnings
        const warningsCollection = db.collection('analysis_warnings');
        const warningsRef = await warningsCollection.add({
            repositoryId,
            warnings: analysis.warnings || [],
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        // Create the main analysis document with a reference to the warnings
        const analysisData = {
            repositoryId,
            repositoryName,
            userId,
            repositoryUrl,
            language: language || 'java',
            warningsRef: warningsRef.id,
            summary: analysis.summary || {
                totalWarnings: analysis.warnings ? analysis.warnings.length : 0,
                criticalCount: 0,
                highCount: 0,
                mediumCount: 0,
                lowCount: 0,
            },
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        
        const analysisRef = await db.collection('analysis').add(analysisData);
        
        console.log(`Analysis saved to database with ID: ${analysisRef.id}`);
        
    } catch (error) {
        console.error('Create analysis error:', error);
        // Since we've already sent a response, we can't send another one
        // Log the error for server-side debugging
    }
});

/**
 * @route POST /api/analysis/:id
 * @description Run analysis on a given repository
 * @access Private
 */
router.post('/:id', auth, async (req, res) => {
    try {
        const analysisId = req.params.id;
        console.log(`[DEBUG] Starting analysis for repository ID: ${analysisId}`);
        
        // Get the repository from Firestore
        const repoDoc = await db.collection('repositories').doc(analysisId).get();
        
        if (!repoDoc.exists) {
            console.log(`[DEBUG] Repository ${analysisId} not found`);
            return res.status(404).json({
                success: true,
                message: 'Repository not found'
            });
        }
        
        const repoData = repoDoc.data();
        
        // Check if the user has access to this repository
        if (repoData.userId !== req.user?.id) {
            console.log(`[DEBUG] Access denied: userId ${req.user?.id} doesn't match repository owner ${repoData.userId}`);
            return res.status(403).json({
                success: false,
                message: 'Access denied'
            });
        }
        
        // Send initial response that the process has started
        res.status(202).json({ 
            success: true,
            message: 'Analysis started',
            status: 'pending',
            id: analysisId
        });
        
        let language = req.body.language || 'java';
        
        console.log(`[DEBUG] Starting scan for repository: ${repoData.name}, language: ${language}`);
        
        try {
            // Run scan using sparse checkout to optimize storage
            const scanResults = await scanRepository(repoData.url, language);
            
            console.log(`[DEBUG] Scan completed for repository: ${repoData.name}`);
            
            // Create a separate document for detailed warnings
            const warningsCollection = db.collection('analysis_warnings');
            const warningsRef = await warningsCollection.add({
                repositoryId: analysisId,
                warnings: scanResults.warnings || [],
                fileContents: scanResults.fileContents || {},
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            
            // Create the main analysis document with a reference to the warnings
            const analysisData = {
                repositoryId: analysisId,
                repositoryName: repoData.name || repoData.fullName,
                userId: req.user?.id,
                repositoryUrl: repoData.url,
                language: language,
                warningsRef: warningsRef.id,
                status: 'completed',
                summary: scanResults.summary || {
                    totalWarnings: scanResults.warnings ? scanResults.warnings.length : 0,
                    criticalCount: 0,
                    highCount: 0,
                    mediumCount: 0,
                    lowCount: 0,
                },
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            };
            
            const analysisRef = await db.collection('analysis').add(analysisData);
            
            console.log(`[DEBUG] Analysis saved to database with ID: ${analysisRef.id}`);
            
            // Update repository with the last analysis reference
            await db.collection('repositories').doc(analysisId).update({
                lastAnalysis: analysisRef.id,
                lastAnalysisDate: admin.firestore.FieldValue.serverTimestamp(),
                status: 'completed',
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            
        } catch (scanError) {
            console.error(`[ERROR] Error in scan: ${scanError.message}`);
            
            // Update repository status to 'failed'
            await db.collection('repositories').doc(analysisId).update({
                status: 'failed',
                errorMessage: scanError.message,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
        }
        
    } catch (error) {
        console.error(`[ERROR] Error in analysis: ${error.message}`);
        // We can't send a response here as we already sent one
    }
});

/**
 * @route POST /api/analysis/:id/fix
 * @description Fix a specific issue in a file
 * @access Private
 */
router.post('/:id/fix', auth, async (req, res) => {
    try {
        const analysisId = req.params.id;
        const { file, line, issue, fixedCode } = req.body;
        
        console.log(`[DEBUG] Saving fix for file ${file} in analysis ${analysisId}`);
        
        if (!file || !fixedCode) {
            return res.status(400).json({
                success: false,
                message: 'File path and fixed code are required'
            });
        }
        
        // Get the analysis from Firestore
        const analysisDoc = await db.collection('analysis').doc(analysisId).get();
        
        if (!analysisDoc.exists) {
            console.log(`[DEBUG] Analysis ${analysisId} not found`);
            return res.status(404).json({
                success: false,
                message: 'Analysis not found'
            });
        }
        
        const analysisData = analysisDoc.data();
        
        // Check if user has access to this analysis
        if (analysisData.userId !== req.user?.id) {
            console.log(`[DEBUG] Access denied: userId ${req.user?.id} doesn't match analysis owner ${analysisData.userId}`);
            return res.status(403).json({
                success: false,
                message: 'Access denied'
            });
        }
        
        // Store the fix in Firestore
        const fixData = {
            analysisId,
            repositoryId: analysisData.repositoryId,
            filePath: file,
            lineNumber: line || 0,
            issueDescription: issue || '',
            fixedCode,
            userId: req.user?.id,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        };
        
        // Add the fix to the fixes collection
        const fixRef = await db.collection('code_fixes').add(fixData);
        
        console.log(`[DEBUG] Fix saved with ID: ${fixRef.id}`);
        
        return res.json({
            success: true,
            message: 'Fix saved successfully',
            fixId: fixRef.id
        });
        
    } catch (error) {
        console.error(`[ERROR] Error saving fix: ${error.message}`);
        res.status(500).json({
            success: false,
            message: 'Error saving fix',
            error: error.message
        });
    }
});

module.exports = router;
