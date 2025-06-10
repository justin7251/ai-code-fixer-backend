const admin = require('../../../firebase-admin');
const db = admin.firestore();
const { fetchSingleFile } = require('../utils/sparseCheckout');
// scanRepository is needed for creating analyses
const { scanRepository } = require('../utils/pmdScanner');

/**
 * Fetches all analyses for a given repository and user.
 * @param {string} repositoryId - The ID of the repository.
 * @param {string} userId - The ID of the user.
 * @returns {Promise<Array>} A promise that resolves to an array of analyses.
 */
async function getAnalysesByRepository(repositoryId, userId) {
    try {
        const analysesSnapshot = await db.collection('analysis')
            .where('repositoryId', '==', repositoryId)
            .where('userId', '==', userId)
            .orderBy('createdAt', 'desc')
            .get();

        const analyses = [];
        analysesSnapshot.forEach(doc => {
            analyses.push({
                id: doc.id,
                ...doc.data()
            });
        });
        return analyses;
    } catch (error) {
        console.error(`Error getting analyses for repo ${repositoryId} by user ${userId}:`, error);
        throw new Error('Failed to retrieve analyses for repository.');
    }
}

/**
 * Fetches a single analysis by its ID, ensuring user authorization.
 * @param {string} analysisId - The ID of the analysis.
 * @param {string} userId - The ID of the user for authorization.
 * @returns {Promise<Object|null>} The analysis data including its ID, or null if not found.
 * @throws {Error} If access is denied or a database error occurs.
 */
async function getAnalysisById(analysisId, userId) {
    try {
        const analysisDoc = await db.collection('analysis').doc(analysisId).get();

        if (!analysisDoc.exists) {
            const notFoundError = new Error('Analysis not found');
            notFoundError.code = 'NOT_FOUND';
            throw notFoundError;
        }

        const analysisData = analysisDoc.data();

        if (analysisData.userId !== userId) {
            const authError = new Error('Access denied to analysis');
            authError.code = 'PERMISSION_DENIED';
            throw authError;
        }

        return { id: analysisDoc.id, ...analysisData };
    } catch (error) {
        console.error(`Error getting analysis ${analysisId} by user ${userId}:`, error);
        throw error;
    }
}

/**
 * Fetches warnings for a given analysis, ensuring user authorization.
 * @param {string} analysisId - The ID of the analysis.
 * @param {string} userId - The ID of the user for authorization.
 * @returns {Promise<Array>} An array of warnings.
 * @throws {Error} If analysis or warnings are not found, or access is denied.
 */
async function getAnalysisWarnings(analysisId, userId) {
    try {
        const analysisData = await getAnalysisById(analysisId, userId); // Handles auth & existence of analysis

        if (!analysisData.warningsRef) {
            const noWarningsRefError = new Error('No warnings reference found for this analysis');
            noWarningsRefError.code = 'NOT_FOUND'; // Or a custom code like 'WARNINGS_REF_MISSING'
            throw noWarningsRefError;
        }

        const warningsDoc = await db.collection('analysis_warnings').doc(analysisData.warningsRef).get();

        if (!warningsDoc.exists) {
            const warningsNotFoundError = new Error('Warnings data not found');
            warningsNotFoundError.code = 'NOT_FOUND';
            throw warningsNotFoundError;
        }

        return warningsDoc.data().warnings || [];
    } catch (error) {
        console.error(`Error getting warnings for analysis ${analysisId} by user ${userId}:`, error);
        throw error;
    }
}

/**
 * Fetches file content for an analysis, with GitHub fallback. Ensures user authorization.
 * @param {string} analysisId - The ID of the analysis.
 * @param {string} userId - The ID of the user for authorization.
 * @param {string} filePath - The path of the file.
 * @returns {Promise<Object>} Object with file path and content.
 * @throws {Error} If analysis/file not found, or access denied.
 */
async function getAnalysisFileContent(analysisId, userId, filePath) {
    try {
        const analysisData = await getAnalysisById(analysisId, userId); // Handles auth

        if (!analysisData.warningsRef) {
            console.warn(`No warningsRef for analysis ${analysisId} when fetching file ${filePath}. Falling back to GitHub.`);
            // Fallback to GitHub directly if no warningsRef (e.g., very old analysis or incomplete data)
            return fetchFromGitHub(analysisData.repositoryUrl, filePath);
        }

        const warningsDoc = await db.collection('analysis_warnings').doc(analysisData.warningsRef).get();

        if (!warningsDoc.exists) {
            console.warn(`Warnings document ${analysisData.warningsRef} not found for analysis ${analysisId}. Falling back to GitHub for file ${filePath}.`);
            // Fallback to GitHub if warnings document doesn't exist
            return fetchFromGitHub(analysisData.repositoryUrl, filePath);
        }

        const warningsData = warningsDoc.data();

        if (warningsData.fileContents && warningsData.fileContents[filePath]) {
            return { path: filePath, content: warningsData.fileContents[filePath] };
        }

        console.log(`File ${filePath} not in stored contents for analysis ${analysisId}. Fetching from GitHub.`);
        return fetchFromGitHub(analysisData.repositoryUrl, filePath);

    } catch (error) {
        console.error(`Error getting file content for analysis ${analysisId}, file ${filePath}, user ${userId}:`, error);
        // If the error is already specific (e.g., NOT_FOUND from getAnalysisById), rethrow it.
        // Otherwise, wrap it or throw a more generic error.
        if (error.code === 'NOT_FOUND_IN_REPO' || error.code === 'PERMISSION_DENIED' || error.code === 'NOT_FOUND') {
            throw error;
        }
        throw new Error('Failed to retrieve file content.');
    }
}

// Helper for getAnalysisFileContent to fetch from GitHub
async function fetchFromGitHub(repositoryUrl, filePath) {
    try {
        const content = await fetchSingleFile(repositoryUrl, filePath);
        return { path: filePath, content: content };
    } catch (fetchError) {
        console.error(`Failed to fetch file ${filePath} from GitHub ${repositoryUrl}: ${fetchError.message}`);
        const fileNotFoundError = new Error(`File not found in repository: ${filePath}`);
        fileNotFoundError.code = 'NOT_FOUND_IN_REPO';
        throw fileNotFoundError;
    }
}

/**
 * Creates a new analysis for a repository (corresponds to POST /:id route).
 * This function is intended to be called after an initial response has been sent to the client.
 * @param {string} repositoryId - The ID of the repository (also used as analysisId in this context).
 * @param {string} userId - The ID of the user performing the analysis.
 * @param {string} language - The programming language of the repository.
 * @param {Object} repoData - The repository document data (e.g., from `repositories` collection),
 *                            containing details like `repoData.url`, `repoData.name`.
 * @description This is the primary service method for creating new analyses for repositories
 *              that are already tracked/managed by the application (i.e., exist in the `repositories` collection).
 *              It performs a scan, stores detailed warnings and file contents, creates an analysis record,
 *              and updates the original repository document with the latest analysis status and reference.
 *              This entire process is asynchronous and typically follows an initial '202 Accepted' response from the route.
 */
async function createAnalysisForRepository(repositoryId, userId, language, repoData) {
    console.log(`[AnalysisService] Starting scan for repository: ${repoData.name}, language: ${language} for user ${userId}`);
    try {
        const scanResults = await scanRepository(repoData.url, language);
        console.log(`[AnalysisService] Scan completed for repository: ${repoData.name}`);

        const warningsCollection = db.collection('analysis_warnings');
        const warningsRef = await warningsCollection.add({
            repositoryId: repositoryId,
            warnings: scanResults.warnings || [],
            fileContents: scanResults.fileContents || {}, // Store file contents
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        const analysisData = {
            repositoryId: repositoryId,
            repositoryName: repoData.name || repoData.fullName,
            userId: userId,
            repositoryUrl: repoData.url,
            language: language,
            warningsRef: warningsRef.id,
            status: 'completed',
            summary: scanResults.summary || {
                totalWarnings: scanResults.warnings ? scanResults.warnings.length : 0,
                criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0,
            },
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        const analysisRef = await db.collection('analysis').add(analysisData);
        console.log(`[AnalysisService] Analysis saved to database with ID: ${analysisRef.id}`);

        await db.collection('repositories').doc(repositoryId).update({
            lastAnalysis: analysisRef.id,
            lastAnalysisDate: admin.firestore.FieldValue.serverTimestamp(),
            status: 'completed',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        // No return value needed as this is asynchronous background processing
    } catch (scanError) {
        console.error(`[AnalysisService] Error in scan for repo ${repositoryId}: ${scanError.message}`);
        await db.collection('repositories').doc(repositoryId).update({
            status: 'failed',
            errorMessage: scanError.message,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        // Optionally, rethrow or handle more specifically if direct feedback is needed (though typically not for background tasks)
    }
}

/**
 * Creates a "legacy" analysis, typically corresponding to the unauthenticated `POST /api/analysis` route.
 * This function is intended to be called after an initial '202 Accepted' response has been sent to the client.
 * It takes all necessary data directly as input, performs a scan, and stores the analysis results.
 * It does not assume a pre-existing repository entity in a `repositories` collection that needs updating.
 *
 * @param {Object} data - Data from the request body.
 * @param {string} data.repositoryId - External/self-reported ID for the repository.
 * @param {string} data.repositoryName - Name of the repository.
 * @param {string} data.userId - ID of the user associated with this analysis (from request body).
 * @param {string} data.repositoryUrl - URL of the repository to scan.
 * @param {string} [data.language='java'] - Programming language of the repository.
 * @param {string} [data.customRulesets] - Optional custom PMD rulesets.
 */
async function createLegacyAnalysis(data) {
    const { repositoryId, repositoryName, userId, repositoryUrl, language, customRulesets } = data;
    console.log(`[AnalysisService] Starting legacy analysis for repository ${repositoryId} (user ${userId}) with language ${language || 'java'}`);

    try {
        const scanResults = await scanRepository(
            repositoryUrl,
            language || 'java',
            customRulesets
        );
        console.log(`[AnalysisService] Legacy PMD scan completed for repository ${repositoryId}`);

        const warningsCollection = db.collection('analysis_warnings');
        const warningsRef = await warningsCollection.add({
            repositoryId, // Store repositoryId for potential linking
            warnings: scanResults.warnings || [],
            // Note: fileContents are not typically stored in this legacy path
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        const analysisData = {
            repositoryId,
            repositoryName,
            userId,
            repositoryUrl,
            language: language || 'java',
            warningsRef: warningsRef.id,
            summary: scanResults.summary || {
                totalWarnings: scanResults.warnings ? scanResults.warnings.length : 0,
                criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0,
            },
            status: 'completed', // Assuming completion
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        const analysisRef = await db.collection('analysis').add(analysisData);
        console.log(`[AnalysisService] Legacy analysis saved to database with ID: ${analysisRef.id}`);
        // No return value needed
    } catch (error) {
        console.error(`[AnalysisService] Create legacy analysis error for repo ${repositoryId}:`, error);
        // Log the error for server-side debugging
    }
}

/**
 * Saves a code fix to Firestore after verifying user authorization.
 * @param {string} analysisId - The ID of the analysis to which this fix pertains.
 * @param {string} userId - The ID of the user submitting the fix.
 * @param {Object} fixDetails - Object containing { file, line, issue, fixedCode }.
 * @returns {Promise<string>} The ID of the saved fix document.
 * @throws {Error} If analysis not found, access denied, or database error.
 */
async function saveCodeFix(analysisId, userId, fixDetails) {
    try {
        // First, verify the user has access to the analysis
        const analysisData = await getAnalysisById(analysisId, userId);
        // If getAnalysisById doesn't throw, user is authorized for this analysisId.
        // However, the POST /:id/fix route uses analysisId as a generic ID,
        // which might not be the Firestore document ID of an analysis.
        // The original code uses analysisId from params, then gets analysisData.repositoryId
        // Let's assume analysisId IS the Firestore document ID of an analysis for this service method.

        const { file, line, issue, fixedCode } = fixDetails;
        if (!file || !fixedCode) {
            const inputError = new Error('File path and fixed code are required for saving a fix.');
            inputError.code = 'BAD_REQUEST';
            throw inputError;
        }

        const fixData = {
            analysisId: analysisId, // The analysis this fix is associated with
            repositoryId: analysisData.repositoryId, // From the fetched and authorized analysis
            filePath: file,
            lineNumber: line || 0,
            issueDescription: issue || '',
            fixedCode,
            userId: userId, // The user who submitted the fix
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        };

        const fixRef = await db.collection('code_fixes').add(fixData);
        console.log(`[AnalysisService] Fix saved with ID: ${fixRef.id} for analysis ${analysisId}`);
        return fixRef.id;
    } catch (error) {
        console.error(`[AnalysisService] Error saving fix for analysis ${analysisId} by user ${userId}:`, error);
        throw error; // Rethrow for the route handler
    }
}

/**
 * Fetches a repository document by its ID and checks user ownership.
 * @param {string} repositoryId - The ID of the repository.
 * @param {string} userId - The ID of the user.
 * @returns {Promise<Object|null>} The repository data or null if not found.
 * @throws {Error} If access is denied or DB error.
 */
async function getRepositoryById(repositoryId, userId) {
    try {
        const repoDoc = await db.collection('repositories').doc(repositoryId).get();

        if (!repoDoc.exists) {
            const notFoundError = new Error('Repository not found');
            notFoundError.code = 'NOT_FOUND';
            throw notFoundError;
        }

        const repoData = repoDoc.data();
        if (repoData.userId !== userId) {
            const authError = new Error('Access denied to repository');
            authError.code = 'PERMISSION_DENIED';
            throw authError;
        }
        return repoData;
    } catch (error) {
        console.error(`Error fetching repository ${repositoryId} for user ${userId}:`, error);
        throw error;
    }
}


module.exports = {
    getAnalysesByRepository,
    getAnalysisById,
    getAnalysisWarnings,
    getAnalysisFileContent,
    createAnalysisForRepository,
    createLegacyAnalysis,
    saveCodeFix,
    getRepositoryById, // Exporting for use in POST /:id route
};

/*
UNIT TEST OUTLINE for analysisService.js

General Approach:
- Mock Firestore: For each test, the `db` instance and its methods (`collection`, `doc`, `get`, `add`, `update`, `where`, `orderBy`) will be mocked using a library like Jest (`jest.mock`, `jest.fn()`).
  - `get`: Mock to return objects like `{ exists: true, data: () => ({...}) }` or `{ exists: false }`.
  - `add`: Mock to return an object like `{ id: 'mocked-doc-id' }`.
  - `update`: Mock to resolve successfully.
  - `where().where().orderBy().get()`: Mock the chained calls, with the final `get()` returning a snapshot mock (e.g., `{ docs: [{ id: 'id1', data: () => ({...}) }], empty: false }` or `{ docs: [], empty: true }`).
- Mock other external dependencies:
  - `sparseCheckout.fetchSingleFile`: Mock its return value (file content or throw error).
  - `pmdScanner.scanRepository`: Mock its return value (scan results or throw error).
- Test each service method for different scenarios:
  - Success cases with valid inputs and expected DB responses.
  - "Not Found" cases where DB queries return no data.
  - "Permission Denied" cases for methods involving user ID checks.
  - Error handling for failed DB operations or other exceptions.
- Assertions will focus on:
  - Whether the correct Firestore methods were called with the expected parameters.
  - The return value of the service method.
  - Whether appropriate errors (with specific codes like `NOT_FOUND`, `PERMISSION_DENIED`) are thrown.

Key Service Methods to Test:

1. getAnalysesByRepository(repositoryId, userId)
   - Success: Firestore `get` returns a snapshot with analysis documents. -> Returns array of analyses.
   - Success (No Analyses): Firestore `get` returns an empty snapshot. -> Returns empty array.
   - DB Error: Firestore `get` throws an error. -> Throws an error.

2. getAnalysisById(analysisId, userId)
   - Success: Firestore `doc().get()` returns an existing doc matching `userId`. -> Returns analysis object.
   - Not Found: `doc().get()` returns `{ exists: false }`. -> Throws `NOT_FOUND` error.
   - Permission Denied: `doc().get()` returns doc but `userId` doesn't match. -> Throws `PERMISSION_DENIED` error.
   - DB Error: `doc().get()` throws. -> Throws generic error.

3. getAnalysisWarnings(analysisId, userId)
   - Mocks: `getAnalysisById` (or its underlying DB calls).
   - Success: `getAnalysisById` returns valid analysis with `warningsRef`. Firestore `doc(warningsRef).get()` returns warnings doc. -> Returns warnings array.
   - Analysis Not Found: `getAnalysisById` throws `NOT_FOUND`. -> Rethrows `NOT_FOUND`.
   - Permission Denied: `getAnalysisById` throws `PERMISSION_DENIED`. -> Rethrows `PERMISSION_DENIED`.
   - No WarningsRef: `analysisData.warningsRef` is null/undefined. -> Throws `NOT_FOUND` (or specific code like 'WARNINGS_REF_MISSING').
   - Warnings Doc Not Found: `db.collection('analysis_warnings').doc(warningsRef).get()` returns `{ exists: false }`. -> Throws `NOT_FOUND`.

4. getAnalysisFileContent(analysisId, userId, filePath)
   - Mocks: `getAnalysisById`, `db.collection('analysis_warnings').doc().get()`, `fetchSingleFile`.
   - Success (from DB): `analysisData.warningsRef` exists, `warningsDoc.fileContents[filePath]` exists. -> Returns `{ path, content }`.
   - Success (from GitHub): `warningsDoc.fileContents[filePath]` does not exist. `fetchSingleFile` returns content. -> Returns `{ path, content }`.
   - Not Found (GitHub fallback fails): `fetchSingleFile` throws. -> Throws `NOT_FOUND_IN_REPO`.
   - Analysis/Warnings Not Found/Permission Denied: Handled by underlying calls to `getAnalysisById`. -> Rethrows respective errors.
   - No warningsRef but GitHub success: `analysisData.warningsRef` is null, `fetchSingleFile` succeeds. -> Returns `{ path, content }`.

5. getRepositoryById(repositoryId, userId)
   - Success: Firestore `doc().get()` returns an existing repo doc matching `userId`. -> Returns repo data.
   - Not Found: `doc().get()` returns `{ exists: false }`. -> Throws `NOT_FOUND` error.
   - Permission Denied: `doc().get()` returns doc but `userId` doesn't match. -> Throws `PERMISSION_DENIED` error.

6. createAnalysisForRepository(repositoryId, userId, language, repoData)
   - Mocks: `scanRepository`, `db.collection('analysis_warnings').add()`, `db.collection('analysis').add()`, `db.collection('repositories').doc().update()`.
   - Success: All mocks succeed. -> Verifies `add` and `update` calls with correct data. No specific return value to assert beyond successful promise resolution.
   - Scan Fails: `scanRepository` throws an error. -> Verifies `db.collection('repositories').doc().update()` is called with status 'failed' and errorMessage.
   - DB Add/Update Fails: Any Firestore `add` or `update` call throws. -> Test if errors are caught and logged (or rethrown if applicable, though for background tasks, usually just logged).

7. createLegacyAnalysis(data)
   - Mocks: `scanRepository`, `db.collection('analysis_warnings').add()`, `db.collection('analysis').add()`.
   - Success: All mocks succeed. -> Verifies `add` calls with correct data.
   - Scan Fails: `scanRepository` throws. -> Error is caught and logged.
   - DB Add Fails: Firestore `add` throws. -> Error is caught and logged.
   - Input Validation: Test with missing required fields in `data` (though this is more for the route handler, the service might assume valid data or re-validate).

8. saveCodeFix(analysisId, userId, fixDetails)
   - Mocks: `getAnalysisById`, `db.collection('code_fixes').add()`.
   - Success: `getAnalysisById` returns valid analysis. `db.collection('code_fixes').add()` succeeds. -> Returns `fixRef.id`.
   - Analysis Not Found/Permission Denied: `getAnalysisById` throws. -> Rethrows the error.
   - Invalid Input: `fixDetails` missing `file` or `fixedCode`. -> Throws `BAD_REQUEST` error.
   - DB Add Fails: `add()` throws. -> Rethrows error.
*/
