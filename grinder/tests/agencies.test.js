import test from 'node:test'
import assert from 'node:assert/strict'

import { agencyDomains, resolveAgencyFromUrl } from '../config/agencies.js'

test('resolveAgencyFromUrl covers all configured agency domains', () => {
	let expectedByDomain = new Map()
	for (let [agencyName, domains] of Object.entries(agencyDomains)) {
		for (let domain of domains || []) {
			let normalized = String(domain || '').trim().toLowerCase()
			if (!normalized || expectedByDomain.has(normalized)) continue
			expectedByDomain.set(normalized, agencyName)
		}
	}

	for (let [domain, agencyName] of expectedByDomain.entries()) {
		assert.equal(
			resolveAgencyFromUrl(`https://${domain}/story`),
			agencyName,
			`expected root domain ${domain} to resolve as ${agencyName}`
		)
		assert.equal(
			resolveAgencyFromUrl(`https://www.${domain}/story`),
			agencyName,
			`expected www domain ${domain} to resolve as ${agencyName}`
		)
	}
})
