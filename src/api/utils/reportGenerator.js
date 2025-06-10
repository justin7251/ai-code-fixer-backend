const xml2js = require('xml2js');

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

module.exports = {
    generatePmdXml,
    generateCheckstyleXml,
    generateCsv,
    generateHtmlReport,
    generateFileListHtml
};

/*
UNIT TEST OUTLINE for reportGenerator.js

General Approach:
- Mock input data (warnings arrays, analysisData objects).
- For each function, test with various scenarios:
  - Empty warnings array.
  - Warnings array with one or more items.
  - Different types of warning severities/priorities if applicable.
  - analysisData with typical and edge-case values.
- Assertions will focus on the structure and content of the generated report string.

1. generatePmdXml(warnings, analysisData)
   - Test Inputs:
     - `warnings`: Empty array, array with sample warnings (varying fields like line, column, rule, ruleset, description, priority, endLine, endColumn).
     - `analysisData`: Object with `repositoryId`, `language`.
   - Assertions:
     - Valid XML string is produced.
     - Root element is `<pmd>`.
     - Check for presence of `timestamp`, `version`, `analysis-id` attributes in `<pmd>`.
     - For each file in warnings, a `<file name="...">` element exists.
     - For each warning, a `<violation ...>` element exists with correct attributes (beginline, endline, rule, ruleset, priority, externalInfoUrl) and description content.
     - Handles cases where optional fields (endLine, endColumn, column, priority) are missing in warnings.

2. generateCheckstyleXml(warnings, analysisData)
   - Test Inputs:
     - `warnings`: Empty array, array with sample warnings (file, line, column, severity, description, ruleset, rule).
     - `analysisData`: (Not directly used in attributes but good for context).
   - Assertions:
     - Valid XML string is produced.
     - Root element is `<checkstyle>`.
     - Check for `version` attribute in `<checkstyle>`.
     - For each file, a `<file name="...">` element exists.
     - For each warning, an `<error ...>` element exists with correct attributes (line, column, severity, message, source).
     - Verify correct mapping of PMD severity to Checkstyle severity (e.g., 'critical' -> 'error').

3. generateCsv(warnings, analysisData)
   - Test Inputs:
     - `warnings`: Empty array, array with sample warnings.
     - `analysisData`: (Not directly used in content but good for context).
   - Assertions:
     - Correct CSV headers: "File,Line,Column,Rule,Ruleset,Priority,Severity,Description".
     - For empty warnings, only headers are present.
     - For each warning, a row is generated with values in the correct order.
     - Description field with commas or quotes is properly escaped (quoted and double-quoted).

4. generateFileListHtml(warnings) - (Helper for generateHtmlReport)
   - Test Inputs:
     - `warnings`: Empty array, array with sample warnings (file, line, column, rule, description, severity, priority, ruleset).
   - Assertions:
     - For empty warnings, returns an empty string or a placeholder message.
     - For each file group, a `div.file-item` is created.
       - Contains `div.file-header` with filename and issue count.
       - Contains `ul.file-warnings` with `li.warning-item` for each warning.
     - Each `li.warning-item` should:
       - Have a class corresponding to its severity (e.g., "critical", "high").
       - Display rule, location (line, column), description, severity, priority, ruleset.
     - Files are sorted by warning count (descending) - this might be harder to unit test without deeper inspection or making the sort function separately testable.

5. generateHtmlReport(warnings, analysisData)
   - Test Inputs:
     - `warnings`: Empty array, array with sample warnings.
     - `analysisData`: Object with `repositoryName`, `language`, `createdAt` (as a Date-like object or timestamp), `summary` (with counts like criticalCount, highCount, etc.).
   - Assertions:
     - Returns a complete HTML document string (`<!DOCTYPE html>...</html>`).
     - Title contains `analysisData.repositoryName`.
     - Repository info section displays `repositoryName`, `language`, `analysisDate`.
     - Summary section displays correct counts from `analysisData.summary`.
     - Contains the output of `generateFileListHtml(warnings)` within `<div id="fileList">`.
     - Includes the JavaScript for filtering and toggling.
     - Check for basic HTML structure and presence of key CSS classes.
*/
