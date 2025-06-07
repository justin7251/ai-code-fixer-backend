const axios = require('axios');
const simpleGit = require('simple-git');
const fs = require('fs').promises;
const path = require('path');

const verifyGitHubToken = async (token) => {
    try {
        const response = await axios.get('https://api.github.com/user', {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });

        if (response.data && response.data.id) {
            return {
                id: response.data.id,
                login: response.data.login,
                name: response.data.name,
                email: response.data.email
            };
        }
        throw new Error('Invalid GitHub user data');
    } catch (error) {
        console.error('[GITHUB ERROR]', error.response?.data || error.message);
        throw new Error('Invalid GitHub token');
    }
};

module.exports = {
    verifyGitHubToken
};

const cloneRepository = async (repoUrl, localPath) => {
    try {
        await simpleGit().clone(repoUrl, localPath);
        console.log(`Repository cloned to ${localPath}`);
    } catch (error) {
        console.error(`Error cloning repository: ${error.message}`);
        throw error;
    }
};

const createBranch = async (localPath, branchName) => {
    try {
        const git = simpleGit(localPath);
        await git.checkoutLocalBranch(branchName);
        console.log(`Branch ${branchName} created and checked out`);
    } catch (error) {
        console.error(`Error creating branch: ${error.message}`);
        throw error;
    }
};

const stageFile = async (localPath, filePath) => {
    try {
        const git = simpleGit(localPath);
        await git.add(filePath);
        console.log(`File ${filePath} staged`);
    } catch (error) {
        console.error(`Error staging file: ${error.message}`);
        throw error;
    }
};

const commitChanges = async (localPath, message) => {
    try {
        const git = simpleGit(localPath);
        await git.commit(message);
        console.log(`Changes committed with message: "${message}"`);
    } catch (error) {
        console.error(`Error committing changes: ${error.message}`);
        throw error;
    }
};

const pushChanges = async (localPath, branchName, remoteName = 'origin') => {
    try {
        const git = simpleGit(localPath);
        await git.push(remoteName, branchName);
        console.log(`Changes pushed to ${remoteName}/${branchName}`);
    } catch (error) {
        console.error(`Error pushing changes: ${error.message}`);
        throw error;
    }
};

const getCurrentBranch = async (localPath) => {
    try {
        const git = simpleGit(localPath);
        const branchSummary = await git.branchLocal();
        return branchSummary.current;
    } catch (error) {
        console.error(`Error getting current branch: ${error.message}`);
        throw error;
    }
};

const checkoutBranch = async (localPath, branchName) => {
    try {
        const git = simpleGit(localPath);
        await git.checkout(branchName);
        console.log(`Checked out branch ${branchName}`);
    } catch (error) {
        console.error(`Error checking out branch: ${error.message}`);
        throw error;
    }
};

const pullLatest = async (localPath, branchName) => {
    try {
        const git = simpleGit(localPath);
        await git.pull('origin', branchName);
        console.log(`Pulled latest changes from origin/${branchName}`);
    } catch (error) {
        console.error(`Error pulling latest changes: ${error.message}`);
        throw error;
    }
};

const ensureRepo = async (repoUrl, localPath) => {
    try {
        await fs.access(path.join(localPath, '.git'));
        console.log(`Repository found at ${localPath}. Pulling latest...`);
        const currentBranch = await getCurrentBranch(localPath);
        await pullLatest(localPath, currentBranch);
    } catch (error) {
        // If .git directory doesn't exist or other error (e.g. network issue during pull)
        if (error.code === 'ENOENT') {
            console.log(`Repository not found at ${localPath}. Cloning...`);
            await cloneRepository(repoUrl, localPath);
        } else {
            // Handle other errors from pullLatest or getCurrentBranch
            console.error(`Error ensuring repository: ${error.message}`);
            throw error;
        }
    }
};

const readFileContent = async (localPath, filePath) => {
    try {
        // Assuming ensureRepo has been called and the repo is up-to-date
        const fullPath = path.join(localPath, filePath);
        const content = await fs.readFile(fullPath, 'utf-8');
        return content;
    } catch (error) {
        console.error(`Error reading file content: ${error.message}`);
        throw error;
    }
};

module.exports = {
    verifyGitHubToken,
    cloneRepository,
    createBranch,
    stageFile,
    commitChanges,
    pushChanges,
    getCurrentBranch,
    checkoutBranch,
    pullLatest,
    ensureRepo,
    readFileContent
};
