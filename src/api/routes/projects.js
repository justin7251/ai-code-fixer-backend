const express = require('express');
const router = express.Router();
const admin = require('../../../firebase-admin');
const db = admin.firestore();

// Middleware to verify project access
const verifyProjectAccess = async (req, res, next) => {
    try {
        const projectId = req.params.id;
        const userId = req.user.uid; // Assuming user ID is in the request

        const projectRef = db.collection('projects').doc(projectId);
        const project = await projectRef.get();

        if (!project.exists) {
            return res.status(404).json({ error: 'Project not found' });
        }

        if (project.data().userId !== userId) {
            return res.status(403).json({ error: 'Unauthorized access' });
        }

        req.project = project;
        next();
    } catch (error) {
        console.error('Error verifying project access:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

// Get all projects for the user
router.get('/', async (req, res) => {
    try {
        const userId = req.user.uid;
        const projectsRef = db.collection('projects').where('userId', '==', userId);
        const snapshot = await projectsRef.get();

        const projects = [];
        snapshot.forEach(doc => {
            projects.push({
                id: doc.id,
                ...doc.data()
            });
        });

        res.json(projects);
    } catch (error) {
        console.error('Error fetching projects:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get a specific project
router.get('/:id', verifyProjectAccess, async (req, res) => {
    try {
        res.json({
            id: req.project.id,
            ...req.project.data()
        });
    } catch (error) {
        console.error('Error fetching project:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Create a new project
router.post('/', async (req, res) => {
    try {
        const { name, description, repositoryId } = req.body;
        const userId = req.user.uid;

        const projectRef = db.collection('projects').doc();
        await projectRef.set({
            name,
            description,
            repositoryId,
            userId,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        res.status(201).json({
            id: projectRef.id,
            message: 'Project created successfully'
        });
    } catch (error) {
        console.error('Error creating project:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Project Analysis Endpoints
router.get('/:id/analysis', verifyProjectAccess, async (req, res) => {
    try {
        const projectId = req.params.id;
        const analysisRef = db.collection('analysis').where('projectId', '==', projectId);
        const snapshot = await analysisRef.get();

        if (snapshot.empty) {
            return res.status(404).json({ error: 'No analysis found for this project' });
        }

        const analysis = [];
        snapshot.forEach(doc => {
            analysis.push({
                id: doc.id,
                ...doc.data()
            });
        });

        res.json(analysis);
    } catch (error) {
        console.error('Error fetching project analysis:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.post('/:id/analysis', verifyProjectAccess, async (req, res) => {
    try {
        const projectId = req.params.id;
        const { type, parameters } = req.body;

        const analysisRef = db.collection('analysis').doc();
        await analysisRef.set({
            projectId,
            type,
            parameters,
            status: 'pending',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        res.status(201).json({
            id: analysisRef.id,
            message: 'Analysis started successfully'
        });
    } catch (error) {
        console.error('Error starting analysis:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Project Issues Endpoints
router.get('/:id/issues', verifyProjectAccess, async (req, res) => {
    try {
        const projectId = req.params.id;
        const issuesRef = db.collection('issues').where('projectId', '==', projectId);
        const snapshot = await issuesRef.get();

        const issues = [];
        snapshot.forEach(doc => {
            issues.push({
                id: doc.id,
                ...doc.data()
            });
        });

        res.json(issues);
    } catch (error) {
        console.error('Error fetching project issues:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router; 