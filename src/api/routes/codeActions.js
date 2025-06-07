const express = require('express');
const admin = require('firebase-admin');
const path = require('path');
const os = require('os');
const fs = require('fs').promises; // For cleanup

const {
    ensureRepo,
    checkoutBranch,
    pullLatest,
    createBranch,
    stageFile,
    commitChanges,
    pushChanges,
    getCurrentBranch // May be useful
} = require('../utils/github');

const {
    generateAndApplyFixInPlace
} = require('../utils/aiCodeFixer');

const router = express.Router();

// Middleware to check authentication (assuming you have one, e.g., checkAuth)
// For now, we'll assume req.user is populated by a previous middleware
// const checkAuth = require('../middleware/checkAuth');
// router.use(checkAuth);


router.post('/:repoId/fix-and-push', async (req, res) => {
    const { repoId } = req.params;
    const {
        filePathInRepo, // e.g., 'src/components/myFile.js'
        issue,          // e.g., { line: 10, message: "Syntax error" }
        language,       // e.g., 'javascript'
        baseBranch,     // e.g., 'main'
        commitMessage: customCommitMessage // Optional custom commit message
    } = req.body;

    // Basic validation
    if (!filePathInRepo || !issue || !language || !baseBranch) {
        return res.status(400).json({
            success: false,
            message: 'Missing required parameters: filePathInRepo, issue, language, or baseBranch.'
        });
    }
    if (typeof issue.line !== 'number' || !issue.message) {
        return res.status(400).json({
            success: false,
            message: 'Invalid issue format. Expecting { line: number, message: string }.'
        });
    }

    let localTempPath; // To be used for cleanup

    try {
        // 1. Fetch repository details from Firestore
        const githubId = req.user?.githubId || req.user?.userId; // Adjust based on your token payload
        if (!githubId) {
            return res.status(401).json({ success: false, message: 'User not authenticated or GitHub ID missing.' });
        }

        const repoDoc = await admin.firestore().collection('users').doc(githubId).collection('repositories').doc(repoId).get();
        if (!repoDoc.exists) {
            return res.status(404).json({ success: false, message: 'Repository not found or user does not have access.' });
        }
        const repoData = repoDoc.data();
        const repoUrl = repoData.cloneUrl; // Assuming 'cloneUrl' is stored
        const repoFullName = repoData.fullName; // e.g., "owner/repoName"

        if (!repoUrl || !repoFullName) {
            return res.status(500).json({ success: false, message: 'Repository clone URL or full name is missing from database.' });
        }

        // 2. Generate a unique temporary path for cloning
        const uniqueId = `repo-${repoId}-${Date.now()}`;
        localTempPath = path.join(os.tmpdir(), 'ai-code-fixer-clones', uniqueId);
        await fs.mkdir(localTempPath, { recursive: true });

        // 3. Define a new branch name
        const newBranchName = `ai-fix/${baseBranch.replace(/[^a-zA-Z0-9]/g, '-')}/${Date.now()}`;

        // 4. Git Operations Orchestration
        console.log(`Ensuring repository at ${localTempPath} from ${repoUrl}`);
        await ensureRepo(repoUrl, localTempPath);

        console.log(`Checking out base branch ${baseBranch} in ${localTempPath}`);
        await checkoutBranch(localTempPath, baseBranch); // Checkout base branch first

        console.log(`Pulling latest changes for ${baseBranch} in ${localTempPath}`);
        await pullLatest(localTempPath, baseBranch); // Pull latest on base

        console.log(`Creating new branch ${newBranchName} in ${localTempPath}`);
        await createBranch(localTempPath, newBranchName);

        // Some git versions of simple-git might not switch automatically after checkoutLocalBranch
        // Explicitly checkout to be sure.
        console.log(`Explicitly checking out new branch ${newBranchName} in ${localTempPath}`);
        await checkoutBranch(localTempPath, newBranchName);

        const currentBranch = await getCurrentBranch(localTempPath);
        if (currentBranch !== newBranchName) {
            console.warn(`Current branch is ${currentBranch}, expected ${newBranchName}. Attempting checkout again.`);
            await checkoutBranch(localTempPath, newBranchName);
            const finalBranchCheck = await getCurrentBranch(localTempPath);
            if (finalBranchCheck !== newBranchName) {
                 return res.status(500).json({ success: false, message: `Failed to switch to new branch. Stuck on ${finalBranchCheck}` });
            }
        }
        console.log(`Successfully switched to branch: ${currentBranch}`);


        // 5. AI Fix Application
        console.log(`Applying AI fix for ${filePathInRepo} in ${localTempPath}`);
        const fixResult = await generateAndApplyFixInPlace(localTempPath, filePathInRepo, issue, language);

        // 6. Commit and Push (if fix was successful)
        if (fixResult.success) {
            console.log(`Fix applied successfully. Staging file: ${filePathInRepo}`);
            await stageFile(localTempPath, filePathInRepo);

            const commitMsg = customCommitMessage || `AI Fix: Applied fix for issue in ${filePathInRepo} on line ${issue.line}`;
            console.log(`Committing changes with message: "${commitMsg}"`);
            await commitChanges(localTempPath, commitMsg);

            console.log(`Pushing changes to new branch ${newBranchName}`);
            await pushChanges(localTempPath, newBranchName);

            return res.status(200).json({
                success: true,
                message: 'Fix applied, committed, and pushed successfully.',
                branch: newBranchName,
                repo: repoFullName,
                // You might want to return a URL to the branch or PR here in a real app
            });
        } else {
            console.error('AI fix generation or application failed:', fixResult.error);
            // No changes to push, but the branch might have been created.
            // Decide if you want to delete the remote branch or leave it.
            // For now, just report failure.
            return res.status(500).json({
                success: false,
                message: `Failed to apply AI fix: ${fixResult.error || 'Unknown error from AI fixer'}.`,
                details: fixResult
            });
        }

    } catch (error) {
        console.error('Error in /fix-and-push route:', error);
        return res.status(500).json({
            success: false,
            message: `An unexpected error occurred: ${error.message}`,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    } finally {
        // 7. Cleanup
        if (localTempPath) {
            try {
                console.log(`Cleaning up temporary directory: ${localTempPath}`);
                await fs.rm(localTempPath, { recursive: true, force: true });
                console.log(`Successfully cleaned up ${localTempPath}`);
            } catch (cleanupError) {
                console.error(`Failed to cleanup temporary directory ${localTempPath}:`, cleanupError);
            }
        }
    }
});

module.exports = router;
