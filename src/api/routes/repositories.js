const express = require('express');
const router = express.Router();
const admin = require('../../../firebase-admin');
const db = admin.firestore();

// Get all repositories for the authenticated user
router.get('/', async (req, res) => {
    try {
        const userId = req.user.userId; // Get user ID from decoded token
        console.log('[DEBUG] Fetching repositories for user:', req.user);

        const userReposRef = db.collection('users').doc(String(userId)).collection('repositories');
        const reposSnapshot = await userReposRef.get();
        
        const repositories = [];
        reposSnapshot.forEach(doc => {
            repositories.push({
                id: doc.id,
                ...doc.data()
            });
        });

        console.log('[DEBUG] Retrieved repositories count:', repositories.length);
        res.json({
            success: true,
            repositories
        });
    } catch (error) {
        console.error('[ERROR] Failed to fetch repositories:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch repositories',
            message: error.message
        });
    }
});

// Add a new repository
router.post('/', async (req, res) => {
    try {
        const userId = req.user.githubId;
        const { name, fullName, description, url, private: isPrivate } = req.body;

        if (!name || !fullName || !url) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields',
                message: 'Repository name, full name, and URL are required'
            });
        }

        const userReposRef = db.collection('users').doc(String(userId)).collection('repositories');
        const newRepoRef = await userReposRef.add({
            name,
            fullName,
            description: description || '',
            url,
            private: isPrivate || false,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        const newRepo = await newRepoRef.get();
        res.status(201).json({
            success: true,
            repository: {
                id: newRepo.id,
                ...newRepo.data()
            }
        });
    } catch (error) {
        console.error('[ERROR] Failed to add repository:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to add repository',
            message: error.message
        });
    }
});

router.get('/:id', async (req, res) => {
    try {
        const userId = req.user.githubId;
        const repoId = req.params.id;
        const { name, description, private: isPrivate } = req.body;

        const repoRef = db.collection('users').doc(String(userId)).collection('repositories').doc(repoId);
        const repoDoc = await repoRef.get();

        if (!repoDoc.exists) {
            return res.status(404).json({
                success: false,
                error: 'Repository not found',
                message: 'The specified repository does not exist'
            });
        }

        res.json({
            success: true,
            repository: {
                id: repoDoc.id,
                ...repoDoc.data()
            }
        });
    } catch (error) {
        console.error('[ERROR] Failed to update repository:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to update repository',
            message: error.message
        });
    }
});

// Delete a repository
router.delete('/:id', async (req, res) => {
    try {
        const userId = req.user.githubId;
        const repoId = req.params.id;

        const repoRef = db.collection('users').doc(String(userId)).collection('repositories').doc(repoId);
        const repoDoc = await repoRef.get();

        if (!repoDoc.exists) {
            return res.status(404).json({
                success: false,
                error: 'Repository not found',
                message: 'The specified repository does not exist'
            });
        }

        await repoRef.delete();
        res.json({
            success: true,
            message: 'Repository deleted successfully'
        });
    } catch (error) {
        console.error('[ERROR] Failed to delete repository:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to delete repository',
            message: error.message
        });
    }
});

module.exports = router; 