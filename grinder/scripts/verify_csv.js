import fs from 'node:fs/promises'
import path from 'node:path'

const XAI_API_URL = process.env.XAI_API_URL || 'https://api.x.ai/v1/responses'
const XAI_API_KEY = process.env.XAI_API_KEY || ''
const XAI_MODEL = process.env.XAI_MODEL || 'grok-4'

function parseArgs(argv) {
	let args = { input: '', output: '' }
	for (let i = 0; i < argv.length; i++) {
		let value = argv[i]
		if (value === '--input') args.input = argv[++i]
		else if (value === '--output') args.output = argv[++i]
	}
	return args
}

function parseCsv(text) {
	let rows = []
	let row = []
	let field = ''
	let inQuotes = false
	for (let i = 0; i < text.length; i++) {
		let char = text[i]
		if (inQuotes) {
			if (char === '"') {
				if (text[i + 1] === '"') {
					field += '"'
					i++
				} else {
					inQuotes = false
				}
			} else {
				field += char
			}
			continue
		}
		if (char === '"') {
			inQuotes = true
			continue
		}
		if (char === ',') {
			row.push(field)
			field = ''
			continue
		}
		if (char === '\n') {
			row.push(field)
			field = ''
			if (row.length > 1 || row[0] !== '') rows.push(row)
			row = []
			continue
		}
		if (char === '\r') {
			continue
		}
		field += char
	}
	if (field.length || row.length) {
		row.push(field)
		if (row.length > 1 || row[0] !== '') rows.push(row)
	}
	return rows
}

function cleanJsonText(text) {
	if (!text) return ''
	let trimmed = text.trim()
	if (trimmed.startsWith('```')) {
		trimmed = trimmed.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
	}
	if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed
	let match = trimmed.match(/\{[\s\S]*\}/)
	return match ? match[0] : trimmed
}

function extractResponseText(response) {
	if (!response) return ''
	if (typeof response.output_text === 'string') return response.output_text
	if (Array.isArray(response.output)) {
		for (let item of response.output) {
			if (item?.type !== 'message') continue
			if (!Array.isArray(item.content)) continue
			let text = item.content
				.filter(part => part && (part.type === 'output_text' || typeof part.text === 'string'))
				.map(part => part.text || '')
				.join('')
			if (text) return text
		}
	}
	let fallback = response?.choices?.[0]?.message?.content
	return typeof fallback === 'string' ? fallback : ''
}

async function callXai({ system, prompt }) {
	if (!XAI_API_KEY) throw new Error('XAI_API_KEY is not set')
	let body = {
		model: XAI_MODEL,
		temperature: 0,
		input: [
			{ role: 'system', content: system },
			{ role: 'user', content: prompt },
		],
		tools: [{ type: 'web_search' }],
	}
	let response = await fetch(XAI_API_URL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${XAI_API_KEY}`,
		},
		body: JSON.stringify(body),
	})
	let data = await response.json().catch(() => ({}))
	if (!response.ok) {
		let message = data?.error?.message || data?.message || response.statusText
		throw new Error(`xAI API error: ${message}`)
	}
	return data
}

function formatCsv(rows) {
	let escape = value => {
		if (value == null) return ''
		let str = String(value)
		if (/["\n,]/.test(str)) return `"${str.replace(/"/g, '""')}"`
		return str
	}
	return rows.map(row => row.map(escape).join(',')).join('\n') + '\n'
}

async function verifyRow(row, index, total) {
	let url = row.url?.trim() || ''
	let summary = row.summary?.trim() || ''
	let titleRu = row.titleRu?.trim() || ''
	let titleEn = row.titleEn?.trim() || ''
	let source = row.source?.trim() || ''

	let system = [
		'You verify whether the summary matches the article at the given URL.',
		'Use web_search to fetch the article and confirm its content.',
		'Return ONLY JSON with keys:',
		'- match (boolean)',
		'- confidence (number 0-1)',
		'- reason (string, <=200 chars)',
	].join(' ')
	let user = [
		`URL: ${url}`,
		`Source: ${source}`,
		`Title (RU): ${titleRu}`,
		`Title (EN): ${titleEn}`,
		`Summary: ${summary}`,
	].join('\n')

	process.stdout.write(`[${index + 1}/${total}] verify ${source || url}... `)
	let response = await callXai({ system, prompt: user })
	let text = extractResponseText(response)
	let parsed = JSON.parse(cleanJsonText(text))
	let match = Boolean(parsed.match)
	let confidence = Number(parsed.confidence ?? 0)
	let reason = String(parsed.reason ?? '').slice(0, 200)
	process.stdout.write(`${match ? 'match' : 'mismatch'} (${confidence.toFixed(2)})\n`)
	return { match, confidence, reason }
}

async function main() {
	let { input, output } = parseArgs(process.argv.slice(2))
	if (!input) {
		console.error('Usage: node -r dotenv/config scripts/verify_csv.js --input <file.csv> --output <report.csv>')
		process.exit(1)
	}
	let csv = await fs.readFile(input, 'utf8')
	let rows = parseCsv(csv)
	if (!rows.length) {
		console.error('Empty CSV')
		process.exit(1)
	}
	let header = rows[0]
	let data = rows.slice(1).map(fields => {
		let row = {}
		for (let i = 0; i < header.length; i++) {
			row[header[i]] = fields[i] ?? ''
		}
		return row
	})
	let results = []
	for (let i = 0; i < data.length; i++) {
		let row = data[i]
		let verdict = await verifyRow(row, i, data.length)
		results.push({
			id: row.id || String(i + 1),
			url: row.url,
			source: row.source,
			titleEn: row.titleEn,
			titleRu: row.titleRu,
			match: verdict.match,
			confidence: verdict.confidence,
			reason: verdict.reason,
		})
	}

	let reportRows = [
		['id', 'url', 'source', 'titleEn', 'titleRu', 'match', 'confidence', 'reason'],
		...results.map(r => [
			r.id,
			r.url,
			r.source,
			r.titleEn,
			r.titleRu,
			r.match,
			r.confidence,
			r.reason,
		]),
	]
	let outPath = output || path.join(process.cwd(), 'verify-report.csv')
	await fs.writeFile(outPath, formatCsv(reportRows), 'utf8')

	let matched = results.filter(r => r.match).length
	let mismatched = results.length - matched
	console.log(`Done. match=${matched} mismatch=${mismatched}`)
	console.log(`Report: ${outPath}`)
}

main().catch(error => {
	console.error(error)
	process.exit(1)
})
