import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

function norm(v) {
	return String(v ?? '').trim()
}

function normalizeHeaders(row) {
	let headers = Array.isArray(row) ? row.map(norm) : []
	// Trim trailing empty headers so array lengths stay stable.
	while (headers.length && !headers[headers.length - 1]) headers.pop()
	return headers
}

function parseList(v) {
	if (typeof v !== 'string') return []
	return v
		.split(/[,\n]/g)
		.map(s => s.trim())
		.filter(Boolean)
}

function parseCases() {
	let raw = process.env.E2E_CASES
	if (raw) {
		return raw
			.split(/[;\n]/g)
			.map(s => s.trim())
			.filter(Boolean)
			.map((line, i) => {
				let parts = line.split('|').map(s => s.trim()).filter(Boolean)
				if (parts.length === 1) {
					return { id: String(i + 1), expect: 'ok', label: `case-${i + 1}`, url: parts[0] }
				}
				let expect = (parts[0] || 'ok').toLowerCase()
				if (expect !== 'ok' && expect !== 'fail') expect = 'ok'
				if (parts.length === 2) {
					return { id: String(i + 1), expect, label: `case-${i + 1}`, url: parts[1] }
				}
				let label = parts[1] || `case-${i + 1}`
				let url = parts.slice(2).join('|')
				return { id: String(i + 1), expect, label, url }
			})
			.filter(c => c.url)
	}

	let okUrls = parseList(process.env.E2E_ARTICLE_URLS)
	if (!okUrls.length && process.env.E2E_ARTICLE_URL) okUrls = [process.env.E2E_ARTICLE_URL]

	let failUrls = parseList(process.env.E2E_FAIL_URLS)
	if (!failUrls.length) {
		// Intentionally "valid" URL but with stopword-only slug => no keyword fallback candidates.
		failUrls = ['https://example.invalid/the-and-2026-02-03']
	}

	let cases = []
	for (let u of okUrls) cases.push({ id: String(cases.length + 1), expect: 'ok', label: `ok-${cases.length + 1}`, url: u })
	for (let u of failUrls) cases.push({ id: String(cases.length + 1), expect: 'fail', label: `fail-${cases.length + 1}`, url: u })
	return cases
}

function hasGoogleAuthEnv() {
	let hasOAuth = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN)
	let hasServiceAccount = !!(process.env.SERVICE_ACCOUNT_EMAIL && process.env.SERVICE_ACCOUNT_KEY)
	return hasOAuth || hasServiceAccount
}

const spreadsheetId = process.env.GOOGLE_SHEET_ID_MAIN
const cases = parseCases()
const okCases = cases.filter(c => c.expect === 'ok')

const missing = []
if (!spreadsheetId) missing.push('GOOGLE_SHEET_ID_MAIN (set this to a TEST spreadsheet id in .env.e2e)')
if (!cases.length) missing.push('E2E_CASES (or E2E_ARTICLE_URLS/E2E_ARTICLE_URL)')
if (!okCases.length) missing.push('At least 1 ok case (E2E_CASES=ok|... or E2E_ARTICLE_URLS=...)')
if (!process.env.OPENAI_API_KEY) missing.push('OPENAI_API_KEY')
if (!process.env.NEWS_API_KEY) missing.push('NEWS_API_KEY')
if (!hasGoogleAuthEnv()) missing.push('Google auth env (OAuth or service account)')

if (missing.length) {
	console.warn('E2E summarize skipped; missing env:', missing.join(', '))
}

test('e2e: summarize writes artifacts into test sheet', { timeout: 25 * 60_000, skip: missing.length ? missing.join(', ') : false }, async () => {
	// Prefer service account for E2E if present (OAuth refresh tokens are flaky in automation).
	if (process.env.SERVICE_ACCOUNT_EMAIL && process.env.SERVICE_ACCOUNT_KEY) {
		process.env.GOOGLE_CLIENT_ID = ''
		process.env.GOOGLE_CLIENT_SECRET = ''
		process.env.GOOGLE_REFRESH_TOKEN = ''
	}

	let { clear, ensureSheet, getSpreadsheet, load, loadTable, save } = await import('../src/google-sheets.js')

	let ss = await getSpreadsheet(spreadsheetId, 'properties.title')
	let title = ss?.data?.properties?.title || ''
	assert.match(title, /(test|e2e)/i, `Refusing to run E2E against non-test spreadsheet title: '${title}'`)

	// Keep E2E cheap by default; allow overriding via env.
	process.env.OPENAI_SUMMARIZE_MODEL ||= 'gpt-4o-mini'
	process.env.OPENAI_FACTS_MODEL ||= 'gpt-4.1-mini'
	process.env.OPENAI_VIDEO_VERIFY_MODEL ||= 'gpt-4o-mini'
	process.env.OPENAI_WEBSEARCH_CONTEXT_SIZE ||= 'low'

	await ensureSheet(spreadsheetId, 'news')
	await ensureSheet(spreadsheetId, 'prompts')
	let headerRow = await load(spreadsheetId, 'news!A1:AZ1')
	let headers = normalizeHeaders(headerRow?.[0])
	assert.ok(headers.length, 'E2E requires a header row in news!A1:AZ1 (copy the production/test template sheet)')
	assert.ok(!headers.includes('text'), "E2E refuses to run when the 'text' column exists in the news sheet")

	await clear(spreadsheetId, 'news!A2:AZ')
	await clear(spreadsheetId, 'prompts!A:Z')

	// Seed prompts up-front so we don't mutate the prompts sheet mid-run.
	let { seedMissingPrompts } = await import('../src/prompts.js')
	await seedMissingPrompts(spreadsheetId)

	let rows = cases.map(c => {
		let row = {
			id: c.id,
			source: 'E2E',
			url: c.url,
			summary: '',
			topic: c.expect === 'fail' ? 'other' : '03. US',
			priority: '',
			factsRu: '',
			videoUrls: '',
			titleEn: `E2E ${c.label}`,
			titleRu: '',
		}
		return headers.map(h => row[h] ?? '')
	})
	await save(spreadsheetId, 'news!A2', rows)

	// Clean local artifacts to make assertions meaningful.
	for (let c of cases) {
		for (let p of [`articles/${c.id}.html`, `articles/${c.id}.txt`]) {
			if (fs.existsSync(p)) fs.unlinkSync(p)
		}
	}

	// Import after seeding so store loads the fresh test sheet.
	let { summarize } = await import('../src/2.summarize.js')
	await summarize()

	// Ensure final write is flushed.
	let { save: flush } = await import('../src/store.js')
	await flush()

	let table = await loadTable(spreadsheetId, 'news')
	assert.equal(table.length, cases.length)

	let byId = new Map(table.map(r => [String(r.id), r]))

	for (let c of cases) {
		let e = byId.get(String(c.id))
		assert.ok(e, `Missing row id=${c.id}`)
		assert.ok(String(e.url || '').trim().length > 0, `expected url to be set (id=${c.id})`)

		if (c.expect === 'ok') {
			assert.ok(String(e.summary || '').trim().length > 0, `expected summary (id=${c.id})`)
			assert.ok(String(e.factsRu || '').trim().length > 0, `expected factsRu (id=${c.id})`)
			assert.match(String(e.videoUrls || ''), /https?:\/\//, `expected at least one video URL (id=${c.id})`)
			assert.ok(fs.existsSync(`articles/${c.id}.txt`), `expected articles/{id}.txt artifact (id=${c.id})`)
			let txt = fs.readFileSync(`articles/${c.id}.txt`, 'utf8')
			assert.ok(txt.trim().length > 400, `expected extracted text in articles/{id}.txt artifact (id=${c.id})`)
			continue
		}

		assert.ok(!String(e.summary || '').trim(), `expected empty summary for fail case (id=${c.id})`)
		assert.ok(!fs.existsSync(`articles/${c.id}.txt`), `expected no articles/{id}.txt artifact for fail case (id=${c.id})`)
	}

	let prompts = await load(spreadsheetId, 'prompts!A:A')
	let names = (prompts || []).map(r => r?.[0]).filter(Boolean)
	assert.ok(names.includes('summarize:summary'), 'expected seeded summarize:summary prompt')
	assert.ok(names.includes('summarize:facts'), 'expected seeded summarize:facts prompt')
	assert.ok(names.includes('summarize:videos'), 'expected seeded summarize:videos prompt')
})
