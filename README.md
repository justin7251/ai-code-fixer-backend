
# Set the config
firebase functions:config:set session.secret_key="your-secret-key"

# Deploy the functions
vercel deploy

## Backend Overview

The backend is a Node.js application built with Express.js, responsible for handling code analysis, suggesting AI-powered fixes, and managing repository data. It interfaces with Firebase Firestore for data persistence.

### Core Functionalities:

1.  **Static Code Analysis (PMD & other tools):**
    *   Accepts requests to analyze Git repositories for specified programming languages.
    *   Utilizes PMD (and potentially other static analysis tools via the `code-quality` module) to scan code and identify quality issues, security vulnerabilities, and style inconsistencies.
    *   Generates analysis reports in various formats (JSON, HTML, XML, CSV, Checkstyle).
    *   Stores analysis results, including detailed warnings and scanned file contents, in Firestore.

2.  **AI-Powered Code Fixing:**
    *   Provides endpoints to suggest automated fixes for identified code issues using AI (leveraging `aiCodeFixer.js`).
    *   Can generate fixes for individual issues or entire files.
    *   Offers a feature to automatically apply a fix, commit the changes to a new branch, and push it to the linked GitHub repository (`/api/codeActions/:repoId/fix-and-push`).

3.  **Data Management (Firestore):**
    *   **User Repositories:** Manages a list of user-linked repositories.
    *   **Analysis Data:** Stores comprehensive details for each analysis run, including:
        *   Metadata (repository info, language, user, timestamps).
        *   Aggregated summary of issues.
        *   Detailed warnings and their locations.
        *   Content of the analyzed files.
    *   **Code Fixes:** Records information about applied code fixes, linking them to the original analysis and user.
    *   Key Firestore collections include `analysis`, `analysis_warnings`, `repositories` (often nested under user documents), `code_fixes`, `code_quality_analysis`, and `code_quality_issues`.

4.  **Authentication & Authorization:**
    *   Handles user authentication (e.g., via GitHub tokens).
    *   Ensures users can only access and manage their own repository data and analyses.

### Key Technologies & Structure:

*   **Framework:** Express.js
*   **Language:** JavaScript (Node.js)
*   **Database:** Firebase Firestore
*   **Main API Directories:**
    *   `src/api/routes/`: Defines the API endpoints.
        *   `analysis.js`: Core PMD analysis, report generation, and manual fix saving.
        *   `code-quality.js`: Broader static analysis, AI fix suggestions, and report generation.
        *   `codeActions.js`: Automated fix application with Git commit/push.
        *   `repositories.js`: Management of user-linked repositories.
    *   `src/api/services/`: Contains the business logic (e.g., `analysisService.js`).
    *   `src/api/utils/`: Holds utility modules for PMD scanning (`pmdScanner.js`), AI fixing (`aiCodeFixer.js`), GitHub interactions (`github.js`), report generation (`reportGenerator.js`), etc.

The API is designed to be asynchronous for long-running tasks like code scanning, often returning an initial acknowledgment and processing the analysis in the background.
