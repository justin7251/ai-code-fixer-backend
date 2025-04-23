const express = require('express');
const router = express.Router();
const { generateToken } = require('../utils/token');
const { verifyGitHubToken } = require('../utils/github');

// Convert GitHub token to JWT
router.post('/github-token', async (req, res) => {
    try {
        const { githubToken } = req.body;

        if (!githubToken) {
            return res.status(400).json({
                success: false,
                error: 'Bad Request',
                message: 'GitHub token is required'
            });
        }

        // Verify GitHub token and get user info
        const userInfo = await verifyGitHubToken(githubToken);
        console.log('[DEBUG] GitHub user info:', userInfo);

        // Generate JWT token
        const token = generateToken(userInfo.id);

        res.json({
            success: true,
            token,
            user: userInfo
        });
    } catch (error) {
        console.error('[AUTH ERROR]', error);
        res.status(401).json({
            success: false,
            error: 'Unauthorized',
            message: error.message
        });
    }
});

// Generate a new token for a user (for testing)
router.post('/token', (req, res) => {
    try {
        const { userId } = req.body;

        if (!userId) {
            return res.status(400).json({
                success: false,
                error: 'Bad Request',
                message: 'UserId is required'
            });
        }

        const token = generateToken(userId);

        res.json({
            success: true,
            token
        });
    } catch (error) {
        console.error('[AUTH ERROR]', error);
        res.status(500).json({
            success: false,
            error: 'Internal Server Error',
            message: error.message
        });
    }
});

module.exports = router; 