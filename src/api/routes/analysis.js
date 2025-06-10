const express = require('express');
const router = express.Router();
const { LANGUAGE_RULESETS } = require('../utils/constants'); // Updated import path
const axios = require('axios'); // For /rules
const auth = require('../middlewares/auth');
const {
    generatePmdXml,
    generateCheckstyleXml,
    generateCsv,
    generateHtmlReport
} = require('../utils/reportGenerator');
const analysisService = require('../services/analysisService');

// Helper function to handle service errors and send standardized responses
function handleServiceError(res, error, context) {
    const errorMessage = error.message || 'An unexpected error occurred.';
    const errorCode = error.code || 'UNKNOWN_ERROR'; // Service methods should provide error codes

    console.error(`Error in ${context}: ${errorCode} - ${errorMessage}`, error.stack || '');

    if (!res.headersSent) {
        if (errorCode === 'NOT_FOUND' || errorCode === 'NOT_FOUND_IN_REPO') {
            return res.status(404).json({ success: false, error: errorCode, message: errorMessage });
        } else if (errorCode === 'PERMISSION_DENIED') {
            return res.status(403).json({ success: false, error: errorCode, message: errorMessage });
        } else if (errorCode === 'BAD_REQUEST' || errorCode === 'INVALID_INPUT') {
            return res.status(400).json({ success: false, error: errorCode, message: errorMessage });
        }
        // Default to 500 for other errors
        return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR', message: 'An internal server error occurred.' });
    }
}

// Middleware to handle JSON parsing errors
router.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.error('JSON Parse Error:', err.message);
    return res.status(400).json({ 
      success: false, 
      error: 'INVALID_JSON', // Standardized error type
      message: 'Invalid JSON in request body.'
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
            data: { languages: supportedLanguages }
        });
    } catch (error) {
        // This is a server-side configuration error, should rarely happen if LANGUAGE_RULESETS is valid
        console.error('Get languages error (config issue):', error);
        res.status(500).json({
            success: false,
            error: 'SERVER_CONFIG_ERROR',
            message: 'Failed to retrieve supported languages due to a server configuration issue.'
        });
    }
});

// Generate PMD rules from docs 
router.get('/rules/:language', auth, async (req, res) => {
    const { language: langParam } = req.params;
    const language = langParam.toLowerCase();

    if (!LANGUAGE_RULESETS[language]) {
        return res.status(400).json({
            success: false,
            error: 'UNSUPPORTED_LANGUAGE',
            message: `Unsupported language: ${language}`
        });
    }

    try {
        let docUrl;
        if (language === 'typescript') {
            docUrl = 'https://docs.pmd-code.org/latest/pmd_rules_ecmascript.html';
        } else {
            docUrl = `https://docs.pmd-code.org/latest/pmd_rules_${language}.html`;
        }
        
        await axios.get(docUrl); // We don't use the response directly, just check if it's fetchable
            
        res.json({
            success: true,
            data: {
                language,
                docsUrl: docUrl,
                rulesets: LANGUAGE_RULESETS[language].split(',')
            }
        });
    } catch (error) {
        console.error(`Get rules error for ${language}:`, error.message);
        if (error.isAxiosError) {
             return res.status(503).json({
                success: false,
                error: 'EXTERNAL_RESOURCE_UNAVAILABLE',
                message: `Failed to fetch rules documentation for ${language}. The external PMD documentation site might be down or the URL may have changed.`
            });
        }
        res.status(500).json({ // Generic server error for other unexpected issues
            success: false,
            error: 'INTERNAL_SERVER_ERROR',
            message: 'Failed to retrieve rules due to an internal server error.'
        });
    }
});

// Get all analyses for a repository
router.get('/repository/:repositoryId', auth, async (req, res) => {
    const { repositoryId } = req.params;
    try {
        const analyses = await analysisService.getAnalysesByRepository(repositoryId, req.user.id);
        res.json({
            success: true,
            data: { analyses }
        });
    } catch (error) {
        handleServiceError(res, error, `getAnalysesByRepository for repo ${repositoryId}`);
    }
});

// Generate PMD report in different formats
router.get('/:id/report/:format', auth, async (req, res) => {
    const { id: analysisId, format: reqFormat } = req.params;
    const format = reqFormat.toLowerCase();
    const validFormats = ['html', 'xml', 'checkstyle', 'json', 'csv'];

    if (!validFormats.includes(format)) {
        return res.status(400).json({
            success: false,
            error: 'UNSUPPORTED_FORMAT',
            message: `Unsupported format: ${format}. Supported formats are: ${validFormats.join(', ')}.`
        });
    }

    try {
        const analysisData = await analysisService.getAnalysisById(analysisId, req.user.id);
        const warnings = await analysisService.getAnalysisWarnings(analysisId, req.user.id);

        switch (format) {
            case 'json':
                return res.json({
                    success: true,
                    data: {
                        report: { analysis: analysisData, warnings }
                    }
                });
            // For file downloads, we don't use the standard JSON response structure
            case 'xml':
                const pmdXml = generatePmdXml(warnings, analysisData);
                res.setHeader('Content-Type', 'application/xml');
                res.setHeader('Content-Disposition', `attachment; filename="pmd-report-${analysisId}.xml"`);
                return res.send(pmdXml);
            case 'checkstyle':
                const checkstyleXml = generateCheckstyleXml(warnings, analysisData);
                res.setHeader('Content-Type', 'application/xml');
                res.setHeader('Content-Disposition', `attachment; filename="checkstyle-report-${analysisId}.xml"`);
                return res.send(checkstyleXml);
            case 'csv':
                const csv = generateCsv(warnings, analysisData);
                res.setHeader('Content-Type', 'text/csv');
                res.setHeader('Content-Disposition', `attachment; filename="pmd-report-${analysisId}.csv"`);
                return res.send(csv);
            case 'html':
                const html = await generateHtmlReport(warnings, analysisData);
                res.setHeader('Content-Type', 'text/html');
                return res.send(html);
        }
    } catch (error) {
        handleServiceError(res, error, `generateReport for analysis ${analysisId}, format ${format}`);
    }
});

// Get detailed warnings for an analysis
router.get('/:id/warnings', auth, async (req, res) => {
    const { id: analysisId } = req.params;
    try {
        const warnings = await analysisService.getAnalysisWarnings(analysisId, req.user.id);
        res.json({
            success: true,
            data: { warnings }
        });
    } catch (error) {
        handleServiceError(res, error, `getAnalysisWarnings for analysis ${analysisId}`);
    }
});

// Get file content from analysis
router.get('/:id/file/:file', auth, async (req, res) => {
    const { id: analysisId, file: encodedFilePath } = req.params;
    const filePath = decodeURIComponent(encodedFilePath);

    // Note: [API] console log was removed as per instructions, but for debugging, it was:
    // console.log(`[API Route] Fetching file ${filePath} for analysis ${analysisId}`);
    try {
        const fileData = await analysisService.getAnalysisFileContent(analysisId, req.user.id, filePath);
        res.json({
            success: true,
            data: { file: fileData } // { path, content }
        });
    } catch (error) {
        handleServiceError(res, error, `getAnalysisFileContent for analysis ${analysisId}, file ${filePath}`);
    }
});

// Get analysis by ID
router.get('/:id', auth, async (req, res) => {
    const { id: analysisId } = req.params;
    try {
        const analysisData = await analysisService.getAnalysisById(analysisId, req.user.id);
        res.json({
            success: true,
            data: { analysis: analysisData }
        });
    } catch (error) {
        handleServiceError(res, error, `getAnalysisById for ID ${analysisId}`);
    }
});

/**
 * @route POST /api/analysis
 * @description LEGACY ROUTE: Creates a new analysis.
 * This route is considered legacy. It directly accepts all repository information
 * in the request body and creates an analysis record without necessarily linking
 * to a pre-existing repository entity managed by the system.
 * It is unauthenticated in its original design but relies on `userId` from the body.
 * Expected payload: { repositoryId, repositoryName, userId, repositoryUrl, language?, customRulesets? }
 * @access Public (by original design, though `userId` is expected in payload)
 */
router.post('/', async (req, res) => {
    const { repositoryId, repositoryName, userId, repositoryUrl, language, customRulesets } = req.body;

    if (!repositoryId || !repositoryName || !userId || !repositoryUrl) {
        return res.status(400).json({
            success: false,
            error: 'MISSING_FIELDS',
            message: 'Missing required fields: repositoryId, repositoryName, userId, repositoryUrl.'
        });
    }

    // Send immediate response
    res.status(202).json({
        success: true,
        message: 'Analysis queued successfully.',
        data: {
            repositoryId,
            language: language || 'java' // Default language
        }
    });

    // Asynchronous operation
    analysisService.createLegacyAnalysis({ repositoryId, repositoryName, userId, repositoryUrl, language, customRulesets })
        .then(() => console.log(`[API] Legacy analysis processing initiated for repo ${repositoryId}`))
        .catch(err => console.error(`[API] Error in background legacy analysis for ${repositoryId}: Name: ${err.name}, Msg: ${err.message}, Code: ${err.code}`, err.stack));
});

/**
 * @route POST /api/analysis/:id
 * @description Run analysis on a given repository (repositoryId from path)
 * @access Private (auth middleware)
 */
router.post('/:id', auth, async (req, res) => {
    const { id: repositoryId } = req.params; // This is the ID of an existing repository document
    const { language: reqLanguage } = req.body;
    const callingUserId = req.user.id; // From auth middleware

    try {
        // console.log(`[API Route] Received request to analyze repository ID: ${repositoryId}`);
        
        // Step 1: Fetch the repository data and verify ownership.
        // This ensures the repository exists and the authenticated user has rights to analyze it.
        const repoData = await analysisService.getRepositoryById(repositoryId, callingUserId);

        // Send initial 202 Accepted response
        res.status(202).json({ 
            success: true,
            message: 'Analysis has been queued and is now processing.',
            data: {
                status: 'pending',
                repositoryId: repositoryId
            }
        });
        
        const language = reqLanguage || repoData.language || 'java';
        
        // Asynchronous operation - do not await in request/response cycle
        analysisService.createAnalysisForRepository(repositoryId, callingUserId, language, repoData)
            .then(() => console.log(`[API] Analysis processing successfully initiated for repo ${repositoryId} by user ${callingUserId}`))
            .catch(err => console.error(`[API] Error in background analysis for repo ${repositoryId}, user ${callingUserId}: Name: ${err.name}, Msg: ${err.message}, Code: ${err.code}`, err.stack));

    } catch (error) {
        // This catch handles errors from getRepositoryById or synchronous issues before the async call
        if (!res.headersSent) { // Ensure response hasn't been sent
             handleServiceError(res, error, `createAnalysisForRepository (initial phase) for repo ${repositoryId}`);
        } else {
            console.error(`[API] Error after response sent for repo ${repositoryId}: ${error.message}`, error.stack);
        }
    }
});


/**
 * @route POST /api/analysis/:id/fix
 * @description Save a code fix for a specific analysis.
 * @access Private (auth middleware)
 */
router.post('/:id/fix', auth, async (req, res) => {
    const { id: analysisId } = req.params;
    const { file, line, issue, fixedCode } = req.body;

    if (!file || !fixedCode) {
        return res.status(400).json({
            success: false,
            error: 'MISSING_FIELDS',
            message: 'File path and fixed code are required.'
        });
    }

    try {
        const fixId = await analysisService.saveCodeFix(analysisId, req.user.id, { file, line, issue, fixedCode });
        res.json({
            success: true,
            message: 'Fix saved successfully.',
            data: { fixId }
        });
    } catch (error) {
        handleServiceError(res, error, `saveCodeFix for analysis ${analysisId}`);
    }
});

module.exports = router;
