"use strict";

/**
 * Validates a user-entered GitHub Enterprise hostname (e.g. `company.ghe.com`).
 * Rejects values that include a scheme, path, port, or refer to `github.com`.
 *
 * @param {string} value - The raw user input.
 * @returns {boolean} Whether the value is a plausible enterprise hostname.
 */
function validEnterpriseHost(value) {
  const v = String(value || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "");
  return (
    /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(v) &&
    v.includes(".") &&
    !v.includes("..") &&
    v.toLowerCase() !== "github.com"
  );
}

/**
 * Normalizes a user-entered hostname by stripping any scheme, path, and
 * port, and lower-casing the result.
 *
 * @param {string} v - The raw user input.
 * @returns {string} The normalized hostname.
 */
function normalizeHost(v) {
  return String(v)
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "")
    .toLowerCase();
}

/**
 * Checks whether a host is a GitHub Enterprise Cloud data-residency host
 * (`*.ghe.com`), as opposed to a self-hosted GitHub Enterprise Server (GHES)
 * appliance hostname. Only `github.com` and `*.ghe.com` hosts support
 * GitHub's enhanced billing platform APIs.
 *
 * @param {string} host - A normalized hostname.
 * @returns {boolean} Whether the host is a GHE.com data-residency host.
 */
function isGheDotComHost(host) {
  return /(^|\.)ghe\.com$/i.test(String(host || "").trim());
}

module.exports = { validEnterpriseHost, normalizeHost, isGheDotComHost };
