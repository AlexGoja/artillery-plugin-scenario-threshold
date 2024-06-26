/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

const debug = require('debug')('plugin:scenario-threshold');
const filtrex = require('filtrex').compileExpression;
const chalk = require('chalk');
const {
    hashString,
    replaceMetricsWithHashes,
    getHashedVarToValueMap
} = require('./utils');
const { uniq, entries } = require('lodash');

class ScenarioThreshold {
    constructor(script, events) {
        // If running in Artillery v1, do nothing
        // If running in Artillery v2, we only want to run on the main thread
        if (!global.artillery) {
            debug('Running in an unsupported Artillery version, nothing to do');
            return;
        }
        if (
            global.artillery &&
            Number(global.artillery.version.slice(0, 1)) === 1
        ) {
            debug('Running in Artillery v1, nothing to do');
            return;
        }

        if (
            global.artillery &&
            Number(global.artillery.version.slice(0, 1)) > 1 &&
            typeof process.env.LOCAL_WORKER_ID !== 'undefined'
        ) {
            debug('Running in a worker, nothing to do');
            return;
        }

        debug('plugin loaded');

        this.script = script;
        this.events = events;

        const scenarios = this.script.scenarios;
        const checks =
            this.script.config['scenario-threshold'] || this.script.config?.plugins['scenario-threshold'];
        let thresholdPerEndpointEnabled = this.script.config?.['scenario-threshold']
            ?.thresholdPerEndpointEnabled
            ? this.script.config['scenario-threshold'].thresholdPerEndpointEnabled
            : false;

        global.artillery.ext({
            ext: 'beforeExit',
            method: async (data) => {
                if (
                    !checks ||
                    typeof process.env.ARTILLERY_DISABLE_ENSURE !== 'undefined'
                ) {
                    return;
                }

                debug(JSON.stringify(data));
                const vars = Object.assign(
                    {},
                    global.artillery.apdexPlugin || {},
                    ScenarioThreshold.statsToVars(data)
                );
                debug({ vars });

                let checkTests = undefined;
                if (thresholdPerEndpointEnabled) {
                    checkTests = ScenarioThreshold.runPerEndpointChecks(
                        checks,
                        vars,
                        scenarios
                    );
                } else {
                    checkTests = ScenarioThreshold.runChecks(checks, vars);
                }

                global.artillery.globalEvents.emit('checks', checkTests);

                function groupBy(arr, property) {
                    return arr.reduce(function (memo, x) {
                        if (!memo[x[property]]) {
                            memo[x[property]] = [];
                        }
                        memo[x[property]].push(x);
                        return memo;
                    }, {});
                }

                const grouped = groupBy(checkTests, 'scenario');

                Object.entries(grouped).map(([scenario, array]) => {
                    scenario !== undefined
                        ? global.artillery.log(`Scenario: ${scenario}`)
                        : global.artillery.log('Scenario: Global');
                    array
                        .sort((a, b) => (a.result < b.result ? 1 : -1))
                        .forEach((check) => {
                            if (check.result !== 1) {
                                global.artillery.log(
                                    `${chalk.red('fail')}: ${check.original}${
                                        check.strict ? '' : ' (optional)'
                                    }`
                                );
                                if (check.strict) {
                                    global.artillery.suggestedExitCode = 1;
                                }
                            } else {
                                global.artillery.log(`${chalk.green('ok')}: ${check.original}`);
                            }
                        });
                });
            }
        });
    }

    // Combine counters/rates/summaries into a flat key->value object for filtrex
    static statsToVars(data) {
        const vars = Object.assign({}, data.report.counters, data.report.rates);

        // Function to hash and assign keys from a given object to the vars object
        const hashAndAssign = (obj) => {
            for (const [key, value] of Object.entries(obj)) {
                const hashedKey = hashString(key);
                vars[key] = {
                    value,
                    hash: hashedKey
                };
            }
        };

        hashAndAssign(data.report.counters);
        hashAndAssign(data.report.rates);

        for (const [name, values] of Object.entries(data.report.summaries || {})) {
            for (const [aggregation, value] of Object.entries(values)) {
                vars[`${name}.${aggregation}`] = {
                    value,
                    hash: hashString(`${name}.${aggregation}`)
                };
            }
        }

        return vars;
    }

    static runPerEndpointChecks(checks, vars, scenarios) {
        const LEGACY_CONDITIONS = ['min', 'max', 'median', 'p95', 'p99'];
        const checkTests = [];

        if (Array.isArray(scenarios)) {
            scenarios.forEach((scenario) => {
                if (typeof scenario === 'object') {
                    if (Array.isArray(scenario.thresholds)) {
                        scenario.thresholds.forEach((threshold) => {
                            if (typeof threshold === 'object') {
                                ScenarioThreshold.generateHashedExpression(
                                    threshold,
                                    vars,
                                    checkTests,
                                    scenario.name
                                );
                            }
                        });
                    }

                    if (Array.isArray(checks.conditions)) {
                        ScenarioThreshold.generateConditionsChecks(
                            checks,
                            vars,
                            checkTests,
                            scenario.name
                        );
                    }

                    ScenarioThreshold.legacyChecks(
                        checks,
                        LEGACY_CONDITIONS,
                        vars,
                        checkTests,
                        scenario.name
                    );

                    const hashedVarsMap = getHashedVarToValueMap(vars);

                    checkTests.forEach((check) => {
                        const result = check.f(hashedVarsMap);
                        check.result = result;
                        debug(`check ${check.original} -> ${result}`);
                    });
                }
            });
        }

        if (checkTests.length > 0) {
            global.artillery.log('\nChecks:');
        }
        return checkTests;
    }

    static generateHashedExpression(threshold, vars, checkTests, scenario) {
        const metricName = Object.keys(threshold)[0]; // only one metric check per array entry
        const maxValue = threshold[metricName];
        const expr = `${metricName} < ${maxValue}`;

        const hashedExpression = replaceMetricsWithHashes(Object.keys(vars), expr);
        let f = () => {};
        try {
            f = filtrex(hashedExpression);
        } catch (err) {
            global.artillery.log(err);
        }

        // all threshold checks are strict:
        checkTests.push({
            scenario: scenario,
            f,
            strict: true,
            original: expr,
            hashed: hashedExpression
        });
    }

    static runChecks(checks, vars) {
        const LEGACY_CONDITIONS = ['min', 'max', 'median', 'p95', 'p99'];
        const checkTests = [];

        if (Array.isArray(checks.thresholds)) {
            checks.thresholds.forEach((o) => {
                if (typeof o === 'object') {
                    ScenarioThreshold.generateHashedExpression(o, vars, checkTests, 'Global');
                }
            });
        }

        if (Array.isArray(checks.conditions)) {
            ScenarioThreshold.generateConditionsChecks(checks, vars, checkTests, 'Global');
        }

        ScenarioThreshold.legacyChecks(
            checks,
            LEGACY_CONDITIONS,
            vars,
            checkTests,
            'Global'
        );

        ScenarioThreshold.maxErrorRateCheck(checks, vars, checkTests, 'Global');

        if (checkTests.length > 0) {
            global.artillery.log('\nChecks:');
        }

        const hashedVarsMap = getHashedVarToValueMap(vars);

        checkTests.forEach((check) => {
            const result = check.f(hashedVarsMap);
            check.result = result;
            debug(`check ${check.original} -> ${result}`);
        });
        return checkTests;
    }

    static maxErrorRateCheck(checks, vars, checkTests, scenario) {
        if (typeof checks.maxErrorRate !== 'undefined') {
            const maxValue = Number(checks.maxErrorRate);
            const expression = `((vusers.created - vusers.completed)/vusers.created * 100) <= ${maxValue}`;

            const hashedExpression = replaceMetricsWithHashes(
                Object.keys(vars),
                expression
            );

            let f = () => {};
            try {
                f = filtrex(hashedExpression);
            } catch (err) {
                global.artillery.log(err);
            }

            checkTests.push({
                scenario: scenario,
                f,
                strict: true,
                original: `maxErrorRate < ${maxValue}`,
                hash: hashedExpression
            });
        }
    }

    static legacyChecks(checks, LEGACY_CONDITIONS, vars, checkTests, scenario) {
        Object.keys(checks)
            .filter((k) => LEGACY_CONDITIONS.indexOf(k) > -1)
            .forEach((k) => {
                const metricName = `http.response_time.${k}`;
                const maxValue = parseInt(checks[k], 10);
                const expression = `${metricName} < ${maxValue}`;

                const hashedExpression = replaceMetricsWithHashes(
                    Object.keys(vars),
                    expression
                );
                let f = () => {};
                try {
                    f = filtrex(hashedExpression);
                } catch (err) {
                    global.artillery.log(err);
                }

                // all legacy threshold checks are strict:
                checkTests.push({
                    scenario: scenario,
                    f,
                    strict: true,
                    original: `${k} < ${maxValue}`,
                    hash: hashedExpression
                });
            });
    }

    static generateConditionsChecks(checks, vars, checkTests, scenario) {
        checks.conditions.forEach((o) => {
            if (typeof o === 'object') {
                const expression = o.expression;
                const strict = typeof o.strict === 'boolean' ? o.strict : true;

                const hashedExpression = replaceMetricsWithHashes(
                    Object.keys(vars),
                    expression
                );

                let f = () => {};
                try {
                    f = filtrex(hashedExpression);
                } catch (err) {
                    global.artillery.log(err);
                }

                checkTests.push({
                    scenario: scenario,
                    f,
                    strict,
                    original: expression,
                    hashed: hashedExpression
                });
            }
        });
    }
}

module.exports = {
    Plugin: ScenarioThreshold
};