// This file contains shared constants used across the application.

const LANGUAGE_RULESETS = {
    java: 'category/java/bestpractices.xml,category/java/errorprone.xml',
    javascript: 'category/ecmascript/bestpractices.xml,category/ecmascript/errorprone.xml',
    typescript: 'category/ecmascript/bestpractices.xml,category/ecmascript/errorprone.xml',
    php: 'category/php/bestpractices.xml,category/php/errorprone.xml',
    python: 'category/python/bestpractices.xml,category/python/errorprone.xml',
    apex: 'category/apex/bestpractices.xml',
    jsp: 'category/jsp/bestpractices.xml',
    plsql: 'category/plsql/bestpractices.xml',
    xml: 'category/xml/errorprone.xml',
    velocity: 'category/vm/bestpractices.xml'
};

module.exports = {
    LANGUAGE_RULESETS,
};
