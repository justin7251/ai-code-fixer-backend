const axios = require('axios');

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