import { firefox } from 'playwright'
import { readFile, stat, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import OpenAI from 'openai'
import { log } from './log.js'
import { readEnv } from './env.js'
import { append, ensureSheet, load, save } from './google-sheets.js'
import { estimateAndLogCost, logRunTotalCost } from './cost.js'
import { buildChatCompletionsRequest } from './openai-request-templates.js'
import { captureScreenshotWithBrightData, describeBrightDataUnlockerSettings, unlockUrlWithBrightData } from './brightdata-unlocker.js'
import { autoSpreadsheetId, mainSpreadsheetId, screenshotLogsSheet } from '../config/google-drive.js'

const IMG_DIR = join(import.meta.dirname, '../../img')
const SCREENSHOTS_FILE = join(IMG_DIR, 'screenshots.txt')

const GOTO_TIMEOUT_MS = 60000
const DOM_READY_TIMEOUT_MS = 15000
const PER_URL_TIMEOUT_MS = 120000
const KNOWN_FIX_PASSES = 2
const VISION_TIMEOUT_MS = 20000
const SCREENSHOT_VISION_REASONING_EFFORT = 'medium'
const SCREENSHOT_LOG_HEADERS = [
	'ts',
	'sqk',
	'source',
	'domain',
	'url',
	'issue',
	'reason',
	'error',
	'url_field',
	'title',
]
const HEALTH_POLICIES = {
	direct: {
		overlayMinArea: 0.16,
		contentAwareOverlayMinArea: 0.28,
	},
	unlocked: {
		overlayMinArea: 0.22,
		contentAwareOverlayMinArea: 0.34,
	},
}

const SAFE_CLICK_TEXTS = [
	'accept all',
	'i accept all',
	'i accept',
	'accept all cookies',
	'allow all cookies',
	'accept',
	'consent',
	'reject all',
	'reject all cookies',
	'reject non-essential',
	'reject nonessential',
	'reject',
	'do not consent',
	'decline',
	'necessary only',
	'use necessary cookies only',
	'only necessary',
	'no thanks',
	'continue without accepting',
	'continue to site',
	'close',
	'dismiss',
	'continue with ads',
	'continue with recommended cookies',
	'i agree',
	'agree',
	'allow all',
	'ok',
	'later',
	'принять',
	'принять все',
	'отклонить',
	'отклонить все',
	'отказаться',
	'закрыть',
	'согласен',
	'соглашаюсь',
	'согласиться',
	'прийняти',
	'прийняти все',
	'прийняти всі',
	'відхилити',
	'відхилити все',
	'відхилити всі',
	'погоджуюсь',
	'погодитися',
	'akzeptieren',
	'alle akzeptieren',
	'ablehnen',
	'schliessen',
	'schließen',
	'zustimmen',
]

const UNSAFE_CLICK_TEXTS = [
	'subscribe',
	'order',
	'buy',
	'watch tv',
	'watch now',
	'sign in',
	'log in',
	'login',
	'register',
	'trial',
	'manage',
	'settings',
]

const CONSENT_SELECTORS = [
	'#onetrust-accept-btn-handler',
	'[id*="onetrust-accept"]',
	'[class*="onetrust"] button',
	'#didomi-notice-agree-button',
	'[id*="didomi"] button',
	'[class*="didomi"] button',
	'#qc-cmp2-ui button',
	'[id*="qc-cmp2"] button',
	'[class*="qc-cmp2"] button',
	'[id*="truste"] button',
	'[class*="truste"] button',
	'[id*="sp_message"] button',
	'[id^="sp_message_container"] button',
	'[class*="sp_message"] button',
	'[id*="cookie"] button',
	'[class*="cookie"] button',
	'[id*="consent"] button',
	'[class*="consent"] button',
	'[id*="privacy"] button',
	'[class*="privacy"] button',
	'[aria-label*="Accept"]',
	'[title*="Accept"]',
]

const OVERLAY_REMOVE_SELECTORS = [
	'[id*="onetrust"]', '[class*="onetrust"]',
	'[id*="didomi"]', '[class*="didomi"]',
	'[id*="qc-cmp2"]', '[class*="qc-cmp2"]',
	'[id*="truste"]', '[class*="truste"]',
	'[id*="sp_message"]', '[class*="sp_message"]', '[id^="sp_message_container"]',
	'[id*="cookie"]', '[class*="cookie"]',
	'[id*="consent"]', '[class*="consent"]',
	'[id*="gdpr"]', '[class*="gdpr"]',
	'[id*="privacy"]', '[class*="privacy"]',
	'[id*="paywall"]', '[class*="paywall"]',
	'[id*="overlay"]', '[class*="overlay"]',
	'[id*="modal"]', '[class*="modal"]',
	'[aria-modal="true"]', '[role="dialog"]',
]

const OPENAI_SCREENSHOT_MODEL = readEnv('OPENAI_SCREENSHOT_MODEL') || 'gpt-4o-mini'
const ENABLE_VISION_FALLBACK = process.env.SCREENSHOT_GPT_FALLBACK !== '0' && !!process.env.OPENAI_API_KEY
const openai = ENABLE_VISION_FALLBACK ? new OpenAI() : null
const ALLOW_LEGACY_SCREENSHOTS_LIST = process.env.SCREENSHOTS_ALLOW_LEGACY_LIST === '1'
const screenshotLogsSpreadsheetId = process.argv[2]?.endsWith('auto')
	? autoSpreadsheetId
	: mainSpreadsheetId

function normalizeHttpUrl(value) {
	if (!value) return ''
	try {
		let url = new URL(String(value).trim())
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
		return url.toString()
	} catch {
		return ''
	}
}

function hostFromUrl(value) {
	try {
		return new URL(String(value).trim()).hostname.toLowerCase()
	} catch {
		return ''
	}
}

function parseScreenshotLine(line) {
	let raw = String(line ?? '').trim()
	if (!raw) return { url: '', meta: {} }

	let parts = raw.split('||')
	let url = normalizeHttpUrl(parts[0])
	let meta = {}
	for (let part of parts.slice(1)) {
		let i = part.indexOf('=')
		if (i <= 0) continue
		let key = part.slice(0, i).trim()
		let value = part.slice(i + 1).trim()
		if (!key) continue
		try {
			meta[key] = decodeURIComponent(value)
		} catch {
			meta[key] = value
		}
	}
	return { url, meta }
}

function extractIssueReason(error) {
	let text = String(error || '')
	let issue = (text.match(/issue=([a-z_]+)/i)?.[1] || 'other').toLowerCase()
	let reason = text.match(/reason=([^\s]+)/i)?.[1] || ''
	return { issue, reason }
}

function normalizeText(value) {
	return String(value ?? '')
		.toLowerCase()
		.replace(/\s+/g, ' ')
		.trim()
}

function isContextDestroyedError(error) {
	const msg = String(error?.message || error || '')
	return msg.includes('Execution context was destroyed')
		|| msg.includes('Cannot find context with specified id')
}

function isDomUnavailableError(error) {
	const msg = String(error?.message || error || '')
	return msg.includes('document.documentElement is null')
		|| msg.includes("can't access property \"clientWidth\"")
		|| msg.includes("can't access property \"style\"")
}

async function waitDom(page, timeout = DOM_READY_TIMEOUT_MS) {
	await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => {})
}

function assertBudget(startedAt, step) {
	if (Date.now() - startedAt > PER_URL_TIMEOUT_MS) {
		throw new Error(`per-url timeout exceeded at step=${step}`)
	}
}

async function withTimeout(promise, ms, label) {
	let timer
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(`timeout:${label}:${ms}ms`)), ms)
			}),
		])
	} finally {
		clearTimeout(timer)
	}
}

async function safeEvaluate(page, fn, ...args) {
	let lastError
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			return await page.evaluate(fn, ...args)
		} catch (e) {
			lastError = e
			if (isContextDestroyedError(e) || isDomUnavailableError(e)) {
				await waitDom(page, 5000)
				await page.waitForTimeout(400)
				continue
			}
			throw e
		}
	}
	throw new Error(`evaluate failed after retries: ${String(lastError?.message || lastError || 'unknown')}`)
}

async function clickByTextInFrame(frame, safeTexts) {
	try {
		return Number(await frame.evaluate((allow, deny) => {
			const normalize = v => String(v || '').toLowerCase().replace(/\s+/g, ' ').trim()
			const nodes = document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], a')
			let clicked = 0
			for (const node of nodes) {
				const text = normalize(node.textContent || node.getAttribute('aria-label') || node.getAttribute('value'))
				if (!text) continue
				if (deny.some(v => text.includes(v))) continue
				if (!allow.some(v => text.includes(v))) continue
				try {
					node.click()
					clicked++
				} catch {}
			}
			return clicked
		}, safeTexts, UNSAFE_CLICK_TEXTS) || 0)
	} catch {
		return 0
	}
}

async function clickBySelectorInFrame(frame, selectors) {
	try {
		return Number(await frame.evaluate((items) => {
			let clicked = 0
			for (const sel of items) {
				const node = document.querySelector(sel)
				if (!node) continue
				try {
					node.click()
					clicked++
				} catch {}
			}
			return clicked
		}, selectors) || 0)
	} catch {
		return 0
	}
}

async function removeBySelectorInFrame(frame, selectors) {
	try {
		return Number(await frame.evaluate((items) => {
			let removed = 0
			for (const sel of items) {
				document.querySelectorAll(sel).forEach(node => {
					try {
						node.remove()
						removed++
					} catch {}
				})
			}
			return removed
		}, selectors) || 0)
	} catch {
		return 0
	}
}

async function clickKnownConsentButtons(page) {
	let clicks = 0
	for (const frame of page.frames()) {
		clicks += await clickByTextInFrame(frame, SAFE_CLICK_TEXTS)
		clicks += await clickBySelectorInFrame(frame, CONSENT_SELECTORS)
	}
	if (clicks > 0) await page.waitForTimeout(500)
	return clicks
}

async function removeKnownOverlays(page) {
	return Number(await safeEvaluate(page, (selectors) => {
		if (!document) return 0
		let removed = 0
		for (const sel of selectors) {
			document.querySelectorAll(sel).forEach(el => {
				try {
					el.remove()
					removed++
				} catch {}
			})
		}
		return removed
	}, OVERLAY_REMOVE_SELECTORS) || 0)
}

async function removeHeuristicBlockers(page) {
	return Number(await safeEvaluate(page, () => {
		if (!document || !document.documentElement || !document.body) return 0

		const vw = Math.max(window.innerWidth || 0, 1)
		const vh = Math.max(window.innerHeight || 0, 1)
		let removed = 0

		const isHinted = (value) => /(cookie|consent|privacy|gdpr|paywall|subscribe|subscriber|sign in|signin|log in|login|register|membership|support journalism|newsletter|overlay|modal|accept|agree|reject|decline|dismiss|close|continue)/i.test(value)

		document.querySelectorAll('*').forEach(el => {
			try {
				const style = getComputedStyle(el)
				if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return
				if (style.position !== 'fixed' && style.position !== 'sticky') return

				const r = el.getBoundingClientRect()
				if (r.width <= 0 || r.height <= 0) return

				const area = (r.width * r.height) / (vw * vh)
				const z = Number(style.zIndex)
				const zHigh = Number.isFinite(z) && z >= 20

				const role = String(el.getAttribute('role') || '').toLowerCase()
				const ariaModal = String(el.getAttribute('aria-modal') || '').toLowerCase()
				const idClass = `${el.id || ''} ${(typeof el.className === 'string' ? el.className : '')}`.toLowerCase()
				const text = String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 1000).toLowerCase()

				const hinted = isHinted(`${idClass} ${role} ${ariaModal} ${text}`)
				const likelyBlocking = area >= 0.2 || (area >= 0.12 && zHigh) || ariaModal === 'true' || role === 'dialog'
				if (!hinted || !likelyBlocking) return
				if (el.querySelector('article, main, h1')) return

				el.remove()
				removed++
			} catch {}
		})

		if (removed > 0) {
			document.body.style.overflow = 'auto'
			document.documentElement.style.overflow = 'auto'
		}
		return removed
	}) || 0)
}

async function pressEscape(page) {
	try {
		await page.keyboard.press('Escape')
		await page.waitForTimeout(250)
	} catch {}
}

async function cleanupCosmetic(page) {
	await safeEvaluate(page, () => {
		if (!document || !document.documentElement) return
		const vw = Math.max(window.innerWidth || 0, 1)
		const vh = Math.max(window.innerHeight || 0, 1)
		const isHinted = (value) => /(cookie|consent|privacy|gdpr|paywall|subscribe|subscriber|sign in|signin|log in|login|register|membership|support journalism|newsletter|overlay|modal|accept|agree|reject|decline|dismiss|close|continue|advert|ad-|ad_|sponsor|promo|video|player|widget|floating|sticky|recommend|related|popup)/i.test(value)

		document.querySelectorAll('*').forEach(el => {
			const style = getComputedStyle(el)
			const isFixed = style.position === 'fixed' || style.position === 'sticky'
			if (!isFixed) return
			const r = el.getBoundingClientRect()
			const coversBigArea = r.width > vw * 0.5 && r.height > vh * 0.2
			const isTallSidebar = r.width > vw * 0.12 && r.height > vh * 0.5
			const isBottomBar = r.bottom >= vh - 2 && r.height > 40 && r.width > vw * 0.55
			const isRightBottom = r.right >= vw - 2 && r.bottom >= vh * 0.55
			const isLeftBottom = r.left <= 2 && r.bottom >= vh * 0.55
			const isCornerWidget = (isRightBottom || isLeftBottom) && r.width <= vw * 0.42 && r.height <= vh * 0.52
			const text = String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 400).toLowerCase()
			const idClass = `${el.id || ''} ${(typeof el.className === 'string' ? el.className : '')}`.toLowerCase()
			const aria = `${String(el.getAttribute('aria-label') || '').toLowerCase()} ${String(el.getAttribute('title') || '').toLowerCase()}`
			const hinted = isHinted(`${idClass} ${aria} ${text}`)
			const isFloatingIframe = el.tagName === 'IFRAME' && isCornerWidget
			if (
				coversBigArea
				|| (isTallSidebar && hinted)
				|| (isBottomBar && hinted)
				|| (isCornerWidget && hinted)
				|| isFloatingIframe
			) {
				try { el.remove() } catch {}
			}
		})

		if (document.body) document.body.style.overflow = 'auto'
		document.documentElement.style.overflow = 'auto'
	})
}

async function alignToContent(page) {
	await safeEvaluate(page, () => {
		const h1 = document.querySelector('h1')
		if (h1) {
			h1.scrollIntoView({ block: 'start' })
			window.scrollBy(0, -140)
			return
		}
		const anchor = document.querySelector('article, main')
		if (anchor) {
			anchor.scrollIntoView({ block: 'start' })
			window.scrollBy(0, -140)
		}
	})
}

async function inspectPage(page, policy = HEALTH_POLICIES.direct) {
	try {
		return await safeEvaluate(page, (healthPolicy) => {
			if (!document || !document.body || !document.documentElement) {
				return {
					ok: false,
					issueType: 'unknown',
					reason: 'document_unavailable',
					hasBlockingOverlay: false,
					hasPrimaryContent: false,
					hasHeadlineVisible: false,
					hasSourceVisible: false,
					overlayCoversHeadline: false,
				}
			}

			const squash = (v) => String(v || '')
				.toLowerCase()
				.replace(/[^a-z0-9\u0400-\u04ff\u0500-\u052f]+/giu, '')
				.trim()
			const normalize = (v) => String(v || '').toLowerCase().replace(/\s+/g, ' ').trim()
			const intersectsViewport = (r, vw, vh) => r && r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw
			const overlapRatio = (a, b) => {
				if (!a || !b) return 0
				const left = Math.max(a.left, b.left)
				const top = Math.max(a.top, b.top)
				const right = Math.min(a.right, b.right)
				const bottom = Math.min(a.bottom, b.bottom)
				const w = Math.max(0, right - left)
				const h = Math.max(0, bottom - top)
				const inter = w * h
				const area = Math.max(1, a.width * a.height)
				return inter / area
			}
			const deriveDomainBase = (hostname) => {
				const clean = String(hostname || '').toLowerCase().trim()
				const parts = clean.split('.').filter(Boolean)
				if (!parts.length) return ''
				const sld = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac'])
				if (parts.length >= 3 && sld.has(parts[parts.length - 2]) && parts[parts.length - 1].length === 2) {
					return parts[parts.length - 3]
				}
				return parts.length >= 2 ? parts[parts.length - 2] : parts[0]
			}

			const titleText = String(document.title || '').trim()
			const ogTitle = String(
				document.querySelector('meta[property="og:title"]')?.getAttribute('content')
				|| document.querySelector('meta[name="twitter:title"]')?.getAttribute('content')
				|| ''
			).trim()
			let headlineEl = document.querySelector('h1')
			let headline = (headlineEl?.innerText || '').trim()
			if (!headline || headline.length < 14) {
				const fallbackHeadlineSelectors = [
					'[itemprop="headline"]',
					'[class*="headline"]',
					'[class*="article-title"]',
					'[class*="story-title"]',
					'article h2',
					'main h2',
					'h2',
				]
				for (const sel of fallbackHeadlineSelectors) {
					if (headline && headline.length >= 14) break
					const nodes = document.querySelectorAll(sel)
					for (const node of nodes) {
						const r = node.getBoundingClientRect()
						if (r.width <= 0 || r.height <= 0) continue
						const text = String(node.textContent || '').replace(/\s+/g, ' ').trim()
						if (text.length < 14 || text.length > 260) continue
						headlineEl = node
						headline = text
						break
					}
				}
			}
			if (!headline || headline.length < 14) {
				headline = (ogTitle || titleText || '').trim()
			}
			const articleText = (document.querySelector('article')?.innerText || document.querySelector('main')?.innerText || '').trim()
			const bodyText = (document.body.innerText || '').trim()
			const scanText = `${headline}\n${bodyText}`.toLowerCase().slice(0, 40000)

				const hasCaptchaSignal = /(captcha|verify you are human|not a robot|security check|access denied|access_denied|unusual traffic|security verification|forbidden|request blocked|attention required|cloudflare|just a moment|bot detection)/i.test(scanText)
				const hasStrictCaptchaSignal = /(verify you are human|not a robot|performing security verification|attention required|cloudflare|just a moment)/i.test(scanText)
				const hasPaywallText = /(subscribe|subscriber|for subscribers|sign in to continue|login to continue|paywall)/i.test(scanText)
				const hasConsentText = /(cookie|consent|privacy settings|we care about your privacy|gdpr|partner)/i.test(scanText)
				const hasSkeletonSignals = /skeleton|shimmer|placeholder|loading/i.test(scanText)
				const hasPrimaryContent =
					((headline.length > 20) && (articleText.length > 80 || bodyText.length > 800))
					|| articleText.length > 500
					|| bodyText.length > 2200
				const overlayMinArea = Number(healthPolicy?.overlayMinArea || 0.16)
				const contentAwareOverlayMinArea = Number(healthPolicy?.contentAwareOverlayMinArea || 0.28)
				const consentHintRegex = /(cookie|consent|privacy|gdpr|partner|accept|agree|reject|decline|manage preferences|your choices|we value your privacy)/
				const paywallHintRegex = /(subscribe|subscriber|sign in|signin|log in|login|paywall|membership|unlock|trial|continue reading)/
				const overlayHintRegex = /(cookie|consent|privacy|gdpr|subscribe|sign in|signin|login|paywall|overlay|modal|dismiss|close|accept|reject|popup|dialog|interstitial|newsletter)/
				const dateVisibleRegex = /\b(?:\d{1,2}[\/\.-]\d{1,2}[\/\.-]\d{2,4}|\d{4}[\/\.-]\d{1,2}[\/\.-]\d{1,2}|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|янв|фев|мар|апр|май|июн|июл|авг|сен|окт|ноя|дек)\b/i
				const bylineHintRegex = /\b(by|author|editor|редактор|автор|журналіст|reuters|associated press|ap news|afp)\b/i

			const vw = Math.max(window.innerWidth || 0, 1)
			const vh = Math.max(window.innerHeight || 0, 1)
			const bodyOverflow = String(getComputedStyle(document.body).overflow || '').toLowerCase()
			const htmlOverflow = String(getComputedStyle(document.documentElement).overflow || '').toLowerCase()
			const overflowLocked = /(hidden|clip)/.test(`${bodyOverflow} ${htmlOverflow}`)
			let headlineRect = null
			let hasHeadlineVisible = false
			if (headlineEl) {
				const r = headlineEl.getBoundingClientRect()
				if (intersectsViewport(r, vw, vh)) {
					const st = getComputedStyle(headlineEl)
					hasHeadlineVisible = headline.length >= 14 && st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0'
					headlineRect = r
				}
			}
			if (!hasHeadlineVisible && headline.length >= 14) {
				const normalizedHeadline = normalize(headline)
				const titleNorm = normalize(titleText)
				const bodyNorm = normalize(bodyText).slice(0, 24000)
				const needle = normalizedHeadline.slice(0, Math.min(52, normalizedHeadline.length))
				if (needle && (titleNorm.includes(needle) || bodyNorm.includes(needle))) {
					hasHeadlineVisible = true
				}
			}
			let hasBlockingOverlay = false
			let overlayText = ''
			let foundDialogLike = false
			let foundBackdropLike = false
			let foundBottomConsentBar = false
			let foundFixedIframeOverlay = false
			let overlayCoversHeadline = false

			const parseAlpha = (color) => {
				const c = String(color || '').trim().toLowerCase()
				if (!c) return 0
				const rgba = c.match(/^rgba\(([^)]+)\)$/i)
				if (rgba) {
					const parts = rgba[1].split(',').map(v => Number(String(v || '').trim()))
					const a = parts[3]
					return Number.isFinite(a) ? a : 1
				}
				if (c.startsWith('rgb(')) return 1
				if (c.startsWith('#')) {
					if (c.length === 5 || c.length === 9) {
						const hex = c.length === 5 ? `${c[4]}${c[4]}` : c.slice(7, 9)
						const n = Number.parseInt(hex, 16)
						if (Number.isFinite(n)) return n / 255
					}
					return 1
				}
				return 0
			}

			document.querySelectorAll('*').forEach(el => {
				const style = getComputedStyle(el)
				if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return
				const isFixedLike = style.position === 'fixed' || style.position === 'sticky'
				const r = el.getBoundingClientRect()
				if (r.width <= 0 || r.height <= 0) return
				const area = (r.width * r.height) / (vw * vh)
				const text = String(el.textContent || '').trim().slice(0, 1200).toLowerCase()
				const idClass = `${el.id || ''} ${(typeof el.className === 'string' ? el.className : '')}`.toLowerCase()
				const role = String(el.getAttribute('role') || '').toLowerCase()
				const ariaModal = String(el.getAttribute('aria-modal') || '').toLowerCase()
				const hinted = overlayHintRegex.test(`${idClass} ${role} ${ariaModal} ${text}`)
				const centeredX = Math.abs((r.left + r.width / 2) - vw / 2) <= vw * 0.22
				const centeredY = Math.abs((r.top + r.height / 2) - vh / 2) <= vh * 0.24
				const centered = centeredX && centeredY
				const isDialogLike = (ariaModal === 'true' || role === 'dialog' || hinted) && area >= 0.05 && area <= 0.82 && centered && (isFixedLike || Number(style.zIndex) >= 20)
				const bgAlpha = parseAlpha(style.backgroundColor)
				const hasBackdropVisual = bgAlpha >= 0.12
				const isBackdropLike = isFixedLike && area >= 0.3 && (r.top <= 2 || r.left <= 2 || r.width >= vw * 0.92 || r.height >= vh * 0.92) && (hasBackdropVisual || hinted || Number(style.zIndex) >= 10)
				const isBottomBar = isFixedLike && r.bottom >= vh - 2 && r.height >= 45 && r.width >= vw * 0.55 && hinted
				const isFixedIframeOverlay = el.tagName === 'IFRAME' && isFixedLike && area >= 0.09 && (hinted || overflowLocked || hasConsentText)
				const isDirectBlocking = isFixedLike && area >= overlayMinArea
				const keepDueToContent = hasPrimaryContent && area < contentAwareOverlayMinArea && !hinted
				const isOverlayLike = isDirectBlocking || isDialogLike || isBackdropLike || isBottomBar || isFixedIframeOverlay

				if (isOverlayLike && headlineRect && isFixedLike) {
					const ratio = overlapRatio(headlineRect, r)
					if (ratio >= 0.18 || (isDialogLike && ratio > 0)) overlayCoversHeadline = true
				}

				if (isDialogLike) {
					foundDialogLike = true
					if (!overlayText && text) overlayText = text
				}
				if (isBackdropLike) {
					foundBackdropLike = true
					if (!overlayText && text) overlayText = text
				}
				if (isBottomBar) {
					foundBottomConsentBar = true
					if (!overlayText && text) overlayText = text
				}
				if (isFixedIframeOverlay) {
					foundFixedIframeOverlay = true
				}
				if (isDirectBlocking && !keepDueToContent) {
					hasBlockingOverlay = true
					if (!overlayText && text) overlayText = text
				}
			})
			if (!hasBlockingOverlay && foundBottomConsentBar) {
				hasBlockingOverlay = true
				if (!overlayText) overlayText = 'consent_bar'
			}
			if (!hasBlockingOverlay && foundDialogLike && (foundBackdropLike || overflowLocked || hasConsentText || hasPaywallText)) {
				hasBlockingOverlay = true
				if (!overlayText) overlayText = 'dialog_overlay'
			}
			if (!hasBlockingOverlay && foundFixedIframeOverlay && (foundBackdropLike || overflowLocked || hasConsentText)) {
				hasBlockingOverlay = true
				if (!overlayText) overlayText = 'iframe_overlay'
			}

			let host = String(location?.hostname || '').toLowerCase().trim()
			while (/^(www\d*|m|mobile|amp|edition|en|us|uk)\./.test(host)) {
				host = host.replace(/^(www\d*|m|mobile|amp|edition|en|us|uk)\./, '')
			}
			const hostParts = host.split('.').filter(Boolean)
			const base = deriveDomainBase(host)
			const generic = new Set([
				'www', 'news', 'media', 'online', 'global', 'world', 'site', 'web', 'live', 'm',
				'amp', 'edition', 'co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'io', 'ai', 'tv',
			])
			const sourceCandidates = new Set()
			for (const label of hostParts) {
				const token = squash(label)
				if (!token || token.length < 2) continue
				if (generic.has(token)) continue
				sourceCandidates.add(token)
			}
			const baseToken = squash(base)
			if (baseToken && baseToken.length >= 2 && !generic.has(baseToken)) {
				sourceCandidates.add(baseToken)
			}
			const ogSiteName = String(
				document.querySelector('meta[property="og:site_name"]')?.getAttribute('content')
				|| document.querySelector('meta[name="application-name"]')?.getAttribute('content')
				|| ''
			).trim()
			const ogToken = squash(ogSiteName)
			if (ogToken && ogToken.length >= 2 && !generic.has(ogToken)) {
				sourceCandidates.add(ogToken)
			}

			let viewportText = ''
			const addViewportText = (value) => {
				const t = normalize(value)
				if (!t || t.length < 2) return
				viewportText += ` ${t}`
				if (viewportText.length > 14000) viewportText = viewportText.slice(0, 14000)
			}
			const headerSelectors = [
				'header',
				'[role="banner"]',
				'nav',
				'h1',
				'h2',
				'time',
				'[class*="logo"]',
				'[id*="logo"]',
				'[data-testid*="logo"]',
				'[data-test*="logo"]',
			]
			for (const sel of headerSelectors) {
				const nodes = document.querySelectorAll(sel)
				for (const node of nodes) {
					const r = node.getBoundingClientRect()
					if (!intersectsViewport(r, vw, vh)) continue
					addViewportText(node.textContent || '')
					addViewportText(node.getAttribute?.('aria-label') || '')
					addViewportText(node.getAttribute?.('title') || '')
				}
			}
			addViewportText(headline)
			const viewportTextNorm = normalize(viewportText)
			const titleTextNorm = normalize(titleText)
			const squashedViewportText = squash(viewportText)
			const squashedTitleText = squash(titleText)

			let attrText = ''
			let scannedAttrNodes = 0
			document.querySelectorAll('img,svg,a,[aria-label],[title],[class],[id]').forEach(node => {
				if (scannedAttrNodes >= 900) return
				const r = node.getBoundingClientRect()
				if (!intersectsViewport(r, vw, vh)) return
				if (r.top > vh * 0.45) return
				scannedAttrNodes++
				const chunk = [
					node.id || '',
					typeof node.className === 'string' ? node.className : '',
					node.getAttribute?.('aria-label') || '',
					node.getAttribute?.('title') || '',
					node.getAttribute?.('alt') || '',
					node.getAttribute?.('src') || '',
					node.getAttribute?.('href') || '',
				].join(' ')
				attrText += ` ${chunk}`
			})
			const squashedAttrText = squash(attrText)
			const hasWordToken = (token) => {
				if (!token) return false
				return new RegExp(`\\b${token}\\b`, 'i').test(viewportTextNorm) || new RegExp(`\\b${token}\\b`, 'i').test(titleTextNorm)
			}
			const hasSourceTextVisible = [...sourceCandidates].some(token => {
				if (token.length <= 3) {
					return hasWordToken(token)
				}
				return squashedViewportText.includes(token) || squashedTitleText.includes(token)
			})
			let hasLogoVisible = false
			document.querySelectorAll('header img, [role="banner"] img, [class*="logo"], [id*="logo"], header svg, [role="banner"] svg, a img').forEach(node => {
				if (hasLogoVisible) return
				const r = node.getBoundingClientRect()
				if (!intersectsViewport(r, vw, vh)) return
				if (r.top > vh * 0.32 || r.left > vw * 0.5) return
				if (r.width < 34 || r.width > vw * 0.38) return
				if (r.height < 10 || r.height > vh * 0.22) return
				const nodeText = normalize([
					node.textContent || '',
					node.getAttribute?.('alt') || '',
					node.getAttribute?.('aria-label') || '',
					node.getAttribute?.('title') || '',
					node.id || '',
					typeof node.className === 'string' ? node.className : '',
					node.getAttribute?.('src') || '',
					node.getAttribute?.('href') || '',
				].join(' '))
				const parent = node.closest?.('a,header,[role="banner"]')
				const parentText = normalize([
					parent?.textContent || '',
					parent?.getAttribute?.('aria-label') || '',
					parent?.getAttribute?.('title') || '',
					parent?.id || '',
					typeof parent?.className === 'string' ? parent.className : '',
					parent?.getAttribute?.('href') || '',
				].join(' '))
				const scan = `${nodeText} ${parentText}`
				const hintedLogo = /(logo|brand|masthead|site[-_ ]?name|header[-_ ]?logo|leftlogo|home)/i.test(scan)
				const hasSourceToken = [...sourceCandidates].some(token => token && scan.includes(token))
				if (hintedLogo || hasSourceToken) {
					hasLogoVisible = true
				}
			})
			const hasSourceVisible = hasSourceTextVisible || hasLogoVisible

				const collectVisibleTextBySelectors = (selectors, options = {}) => {
					const maxNodes = Number(options.maxNodes || 40)
					const maxTopRatio = Number(options.maxTopRatio || 1)
					const minWidthRatio = Number(options.minWidthRatio || 0)
					let out = ''
					let count = 0
					for (const sel of selectors) {
						const nodes = document.querySelectorAll(sel)
						for (const node of nodes) {
							if (count >= maxNodes) break
							const r = node.getBoundingClientRect()
							if (!intersectsViewport(r, vw, vh)) continue
							if (r.top > vh * maxTopRatio) continue
							if (r.width < vw * minWidthRatio) continue
							const text = normalize(node.textContent || '')
							if (!text || text.length < 3) continue
							out += ` ${text}`
							count++
						}
					}
					return normalize(out).slice(0, 4000)
				}

				const subtitleText = collectVisibleTextBySelectors([
					'[class*="subheadline"]',
					'[class*="subtitle"]',
					'[class*="standfirst"]',
					'[class*="dek"]',
					'[itemprop="description"]',
					'article h2',
					'main h2',
					'h2',
				], { maxNodes: 30, maxTopRatio: 0.75, minWidthRatio: 0.18 })
				const hasSubtitleVisible =
					subtitleText.length >= 28
					&& normalize(subtitleText) !== normalize(headline)
					&& !consentHintRegex.test(subtitleText)

				const dateText = collectVisibleTextBySelectors([
					'time',
					'[datetime]',
					'[itemprop*="date"]',
					'[class*="date"]',
					'[class*="time"]',
					'[class*="updated"]',
					'[class*="published"]',
					'[data-testid*="date"]',
					'[data-test*="date"]',
				], { maxNodes: 60, maxTopRatio: 0.9, minWidthRatio: 0.06 })
				const hasDateVisible = dateVisibleRegex.test(dateText)

				const bylineText = collectVisibleTextBySelectors([
					'[itemprop="author"]',
					'[rel="author"]',
					'[class*="author"]',
					'[class*="byline"]',
				], { maxNodes: 24, maxTopRatio: 0.85, minWidthRatio: 0.06 })
				const hasBylineVisible = bylineHintRegex.test(bylineText) && !consentHintRegex.test(bylineText)

				let hasImageVisible = false
				document.querySelectorAll('article img, main img, figure img, picture img, img, video').forEach(node => {
					if (hasImageVisible) return
					const r = node.getBoundingClientRect()
					if (!intersectsViewport(r, vw, vh)) return
					if (r.top > vh * 0.92) return
					if (r.width < vw * 0.22 || r.height < vh * 0.16) return
					const alt = normalize(node.getAttribute?.('alt') || '')
					if (alt && /(logo|icon|avatar|favicon|sprite)/i.test(alt) && r.width < vw * 0.34) return
					hasImageVisible = true
				})

				let visibleParagraphChars = 0
				document.querySelectorAll('article p, main p, p').forEach(node => {
					if (visibleParagraphChars >= 420) return
					const r = node.getBoundingClientRect()
					if (!intersectsViewport(r, vw, vh)) return
					if (r.top > vh * 0.95) return
					if (r.width < vw * 0.28) return
					const text = normalize(node.textContent || '')
					if (text.length < 45) return
					if (consentHintRegex.test(text)) return
					visibleParagraphChars += text.length
				})
				const hasLeadTextVisible = visibleParagraphChars >= 140 || articleText.length >= 220

				const hasCaptcha = hasStrictCaptchaSignal || (hasCaptchaSignal && !hasPrimaryContent)

				let issueType = 'none'
				if (hasCaptcha) issueType = 'captcha'
				else if (hasBlockingOverlay && consentHintRegex.test(overlayText)) issueType = 'consent'
				else if (hasBlockingOverlay && paywallHintRegex.test(overlayText)) issueType = 'paywall'
				else if (hasBlockingOverlay) issueType = 'overlay'
				else if (!hasHeadlineVisible) issueType = 'unknown'
				else if (!hasSourceVisible) issueType = 'source'
				else if (hasPaywallText && !hasHeadlineVisible) issueType = 'paywall'
				else if (!hasPrimaryContent) issueType = 'unknown'

				const ok = hasHeadlineVisible && hasSourceVisible && !hasBlockingOverlay && !hasCaptcha
				if (ok) issueType = 'none'
			let reason = ok ? 'source_visible' : issueType
			if (!ok && hasConsentText && issueType === 'unknown') reason = 'consent_like_unknown'
			if (ok && hasSkeletonSignals) reason = 'source_visible_skeleton'
			if (ok && paywallHintRegex.test(normalize(overlayText)) && hasPaywallText) reason = 'source_visible_paywall'

				return {
					ok,
					issueType,
					reason,
					hasBlockingOverlay,
					hasPrimaryContent,
					hasSkeletonSignals,
					hasHeadlineVisible,
					hasSourceVisible,
					hasSubtitleVisible,
					hasDateVisible,
					hasBylineVisible,
					hasImageVisible,
					hasLeadTextVisible,
					hasPaywallText,
					overlayCoversHeadline,
					host,
					titleText: normalize(titleText).slice(0, 220),
				}
			}, policy)
	} catch (e) {
		return {
			ok: false,
			issueType: 'unknown',
			reason: `inspect_error: ${String(e?.message || e)}`,
				hasBlockingOverlay: false,
				hasPrimaryContent: false,
				hasHeadlineVisible: false,
				hasSourceVisible: false,
				hasSubtitleVisible: false,
				hasDateVisible: false,
				hasBylineVisible: false,
				hasImageVisible: false,
				hasLeadTextVisible: false,
				hasPaywallText: false,
				overlayCoversHeadline: false,
			}
		}
	}

function extractJson(text) {
	if (!text) return null
	let raw = String(text).trim()
	const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
	if (fenced?.[1]) raw = fenced[1]
	const objectMatch = raw.match(/\{[\s\S]*\}/)
	if (objectMatch) raw = objectMatch[0]
	try {
		return JSON.parse(raw)
	} catch {
		return null
	}
}

function shouldUseVisionFallback(check) {
	if (!ENABLE_VISION_FALLBACK || !openai) return false
	if (check?.ok) return false
	if (check?.issueType === 'captcha') return false
	if (check?.issueType === 'paywall') return false
	if (check?.issueType === 'unknown') return true
	if (check?.issueType === 'overlay') return true
	if (check?.issueType === 'consent') return true
	return check?.reason === 'consent_like_unknown'
}

function assessFinalFrameQuality(check) {
	const hasPaywallContext =
		!!check?.hasPaywallText
		|| String(check?.issueType || '').toLowerCase() === 'paywall'
		|| String(check?.reason || '').toLowerCase().includes('paywall')
	const hasSource = !!check?.hasSourceVisible
	const hasHeadline = !!check?.hasHeadlineVisible
	const hasDateOrByline = !!check?.hasDateVisible || !!check?.hasBylineVisible || hasPaywallContext
	const hasLeadText = !!check?.hasLeadTextVisible || !!check?.hasPrimaryContent || hasPaywallContext
	const hasSupportVisual = !!check?.hasSubtitleVisible || !!check?.hasImageVisible || hasPaywallContext
	const hasBlocking = !!check?.hasBlockingOverlay || !!check?.overlayCoversHeadline

	const missing = []
	if (!hasSource) missing.push('source')
	if (!hasHeadline) missing.push('headline')
	if (!hasLeadText) missing.push('text')
	if (hasBlocking) missing.push('overlay')

	const warnings = []
	if (!hasDateOrByline) warnings.push('date_or_byline_missing')
	if (!hasSupportVisual) warnings.push('subtitle_or_image_missing')

	return {
		ok: missing.length === 0,
		reason: missing.length ? `missing_${missing.join('_')}` : 'quality_ok',
		warnings,
	}
}

function shouldUseBrightDataFallback(check) {
	return !check?.ok
}

function escapeHtmlAttr(value) {
	return String(value ?? '')
		.replaceAll('&', '&amp;')
		.replaceAll('"', '&quot;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
}

function buildUnlockedHtml(url, html, options = {}) {
	let raw = String(html || '').trim()
	const stripScripts = options?.stripScripts !== false
	const stripIframes = options?.stripIframes !== false
	raw = raw
		.replace(/<meta[^>]+http-equiv=["']?refresh["']?[^>]*>/gi, '')
	if (stripScripts) {
		raw = raw
			.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
			.replace(/<script\b[^>]*\/>/gi, '')
	}
	if (stripIframes) {
		raw = raw
			.replace(/<iframe\b[\s\S]*?<\/iframe>/gi, '')
			.replace(/<iframe\b[^>]*\/>/gi, '')
	}
	if (!raw) return ''
	const base = `<base href="${escapeHtmlAttr(url)}">`
	const helperCss = `<style>html,body{overflow:auto!important}</style>`
	if (/<head[\s>]/i.test(raw)) {
		return raw.replace(/<head([^>]*)>/i, `<head$1>${base}${helperCss}`)
	}
	if (/<html[\s>]/i.test(raw)) {
		return raw.replace(/<html([^>]*)>/i, `<html$1><head>${base}${helperCss}</head>`)
	}
	return `<!doctype html><html><head><meta charset="utf-8">${base}${helperCss}</head><body>${raw}</body></html>`
}

async function forceRemoveBlockingLayers(page) {
	return Number(await safeEvaluate(page, () => {
		if (!document || !document.documentElement || !document.body) return 0
		const vw = Math.max(window.innerWidth || 0, 1)
		const vh = Math.max(window.innerHeight || 0, 1)
		let removed = 0

		const kill = (el) => {
			try {
				el.remove()
				removed++
			} catch {}
		}

		document.querySelectorAll('iframe, [aria-modal="true"], [role="dialog"]').forEach(kill)

		document.querySelectorAll('*').forEach(el => {
			try {
				const style = getComputedStyle(el)
				if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return
				if (style.position !== 'fixed' && style.position !== 'sticky') return
				const r = el.getBoundingClientRect()
				if (r.width <= 0 || r.height <= 0) return
				const area = (r.width * r.height) / (vw * vh)
				const z = Number(style.zIndex)
				const zHigh = Number.isFinite(z) && z >= 30
				if (area >= 0.08 || zHigh) {
					kill(el)
				}
			} catch {}
		})

		document.body.style.overflow = 'auto'
		document.documentElement.style.overflow = 'auto'
		return removed
	}) || 0)
}

async function loadBrightDataScreenshot(page, { mime, base64 }, startedAt) {
	if (!base64) return false
	assertBudget(startedAt, 'brightdata_screenshot_set_content')
	let imageMime = String(mime || '').trim().toLowerCase() || 'image/jpeg'
	let src = `data:${imageMime};base64,${base64}`
	let html = [
		'<!doctype html><html><head><meta charset="utf-8">',
		'<style>',
		'html,body{margin:0;padding:0;width:100%;height:100%;background:#0f1115;overflow:hidden;}',
		'.frame{width:100vw;height:100vh;display:flex;align-items:center;justify-content:center;}',
		'img{max-width:100vw;max-height:100vh;object-fit:contain;display:block;}',
		'</style></head><body><div class="frame"><img id="bd-shot" alt="brightdata-screenshot" src="',
		src,
		'"></div></body></html>',
	].join('')
	await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS })
	await page.waitForTimeout(500)
	let ok = await safeEvaluate(page, () => {
		let img = document.querySelector('#bd-shot')
		return !!img && img.complete && img.naturalWidth > 0 && img.naturalHeight > 0
	})
	return !!ok
}

async function applyBrightDataFallback(page, { url, check, startedAt }) {
	if (!shouldUseBrightDataFallback(check)) return check
	assertBudget(startedAt, 'brightdata_unlock')
	log('  unresolved, trying Bright Data Web Unlocker...')
	const unlocked = await unlockUrlWithBrightData(url)
	if (!unlocked.ok) {
		log(
			`  brightdata: skipped reason=${unlocked.reason || 'unknown'}`,
			unlocked.limitReached ? 'limit_reached=yes' : '',
			unlocked.statusCode ? `status=${unlocked.statusCode}` : '',
			unlocked.error ? `error=${unlocked.error}` : '',
		)
		return check
	}

	let html = buildUnlockedHtml(url, unlocked.html)
	if (!html) {
		log('  brightdata: empty_html_after_build')
		return check
	}
	log(`  brightdata: unlocked html chars=${html.length}${unlocked.statusCode ? ` status=${unlocked.statusCode}` : ''}`)

	assertBudget(startedAt, 'brightdata_set_content')
	await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS })
	await page.waitForTimeout(1200)
	let next = await inspectPage(page, HEALTH_POLICIES.unlocked)
	if (next.reason === 'document_unavailable') {
		await page.waitForTimeout(1200)
		next = await inspectPage(page, HEALTH_POLICIES.unlocked)
		log(`  health after brightdata retry: ok=${next.ok ? 'yes' : 'no'} issue=${next.issueType} reason=${next.reason}`)
	}
	log(`  health after brightdata load: ok=${next.ok ? 'yes' : 'no'} issue=${next.issueType} reason=${next.reason}`)

	for (let pass = 0; pass < KNOWN_FIX_PASSES && !next.ok; pass++) {
		const actions = await applyKnownFixes(page, startedAt)
		next = await inspectPage(page, HEALTH_POLICIES.unlocked)
		log(`  health after brightdata known-fix #${pass + 1}: ok=${next.ok ? 'yes' : 'no'} issue=${next.issueType}`)
		if (!actions) break
	}

	if (!next.ok) {
		const removed = await forceRemoveBlockingLayers(page)
		if (removed > 0) {
			await waitDom(page, 5000)
			await page.waitForTimeout(500)
			next = await inspectPage(page, HEALTH_POLICIES.unlocked)
			log(`  health after brightdata force-clean: ok=${next.ok ? 'yes' : 'no'} issue=${next.issueType} reason=${next.reason}`)
		}
	}

	if (!next.ok && (next.issueType === 'unknown' || next.reason === 'consent_like_unknown')) {
		const relaxedHtml = buildUnlockedHtml(url, unlocked.html, { stripScripts: false, stripIframes: false })
		if (relaxedHtml && relaxedHtml !== html) {
			log('  brightdata: retry with scripts-preserved html...')
			assertBudget(startedAt, 'brightdata_set_content_relaxed')
			await page.setContent(relaxedHtml, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS })
			await page.waitForTimeout(1800)
			await waitDom(page, 7000)
			next = await inspectPage(page, HEALTH_POLICIES.unlocked)
			log(`  health after brightdata relaxed load: ok=${next.ok ? 'yes' : 'no'} issue=${next.issueType} reason=${next.reason}`)
			if (!next.ok) {
				const actions = await applyKnownFixes(page, startedAt)
				if (actions > 0) {
					next = await inspectPage(page, HEALTH_POLICIES.unlocked)
					log(`  health after brightdata relaxed known-fix: ok=${next.ok ? 'yes' : 'no'} issue=${next.issueType} reason=${next.reason}`)
				}
			}
			if (!next.ok) {
				const removed = await forceRemoveBlockingLayers(page)
				if (removed > 0) {
					await waitDom(page, 5000)
					await page.waitForTimeout(500)
					next = await inspectPage(page, HEALTH_POLICIES.unlocked)
					log(`  health after brightdata relaxed force-clean: ok=${next.ok ? 'yes' : 'no'} issue=${next.issueType} reason=${next.reason}`)
				}
			}
		}
	}

	if (!next.ok) {
		if (next.issueType === 'source') {
			log('  brightdata screenshot skipped: source-only issue')
			return next
		}
		const remainingBudgetMs = PER_URL_TIMEOUT_MS - (Date.now() - startedAt)
		if (remainingBudgetMs < 30000) {
			log(`  brightdata screenshot skipped: low_budget remaining_ms=${Math.max(0, Math.floor(remainingBudgetMs))}`)
			return next
		}
		log('  unresolved after brightdata html, trying brightdata screenshot...')
		const shot = await captureScreenshotWithBrightData(url)
		if (!shot.ok) {
			log(
				`  brightdata screenshot: skipped reason=${shot.reason || 'unknown'}`,
				shot.limitReached ? 'limit_reached=yes' : '',
				shot.statusCode ? `status=${shot.statusCode}` : '',
				shot.error ? `error=${shot.error}` : '',
			)
		} else {
			const loaded = await loadBrightDataScreenshot(page, { mime: shot.mime, base64: shot.base64 }, startedAt)
			if (loaded) {
				log(`  brightdata screenshot: loaded mime=${shot.mime || 'image/jpeg'} bytes=${String(shot.base64 || '').length}`)
				next = {
					ok: true,
					issueType: 'none',
					reason: 'brightdata_screenshot_loaded',
					hasBlockingOverlay: false,
					hasPrimaryContent: true,
				}
			} else {
				log('  brightdata screenshot: load_failed')
			}
		}
	}
	return next
}

async function askVisionAction(page, { url, check }) {
	if (!shouldUseVisionFallback(check)) return null

	const image = await page.screenshot({ type: 'jpeg', quality: 60 })
	const imageUrl = `data:image/jpeg;base64,${image.toString('base64')}`
	let built = buildChatCompletionsRequest({
		model: OPENAI_SCREENSHOT_MODEL,
		temperature: 0,
		reasoningEffort: SCREENSHOT_VISION_REASONING_EFFORT,
		maxTokens: 300,
		messages: [
			{
				role: 'system',
				content: [
					'You are a webpage screenshot assistant.',
					'Return ONLY JSON.',
					'Goal: reveal article content safely.',
					'Never suggest login/subscribe/purchase actions.',
					'Allowed actions: click_text, click_selector, remove_selector, press_escape, none.',
					'You may return one action (actionType...) or multiple actions in actions[] (max 3) for step-by-step cleanup.',
					'For overlays/consent walls, prefer close/dismiss/reject/continue-to-content actions.',
					'If blocked by captcha/paywall, return actionType=none and safe=false.',
				].join(' '),
			},
			{
				role: 'user',
				content: [
					{ type: 'text', text: `URL: ${url}\nCurrent issue: ${check?.issueType || 'unknown'}\nReturn JSON with keys: status, issueType, safe, actionType, targetText, cssSelector, reason. Optional: actions=[{actionType,targetText,cssSelector,safe,status,reason}]` },
					{ type: 'image_url', image_url: { url: imageUrl } },
				],
			},
		],
	})
	const response = await withTimeout(openai.chat.completions.create(built.request), VISION_TIMEOUT_MS, 'gpt_vision')
	estimateAndLogCost({
		task: 'screenshot_vision',
		model: OPENAI_SCREENSHOT_MODEL,
		usage: response?.usage,
		logger: log,
	})

	let content = response?.choices?.[0]?.message?.content || ''
	if (Array.isArray(content)) {
		content = content.map(p => p?.text || '').join('\n')
	}
	return extractJson(content)
}

function normalizeVisionActions(action) {
	if (!action || typeof action !== 'object') return []
	let base = {
		safe: action.safe,
		status: action.status,
	}
	let items = Array.isArray(action.actions) && action.actions.length
		? action.actions.slice(0, 3)
		: [action]
	return items
		.map(item => ({
			...base,
			...(item && typeof item === 'object' ? item : {}),
		}))
		.map(item => {
			let type = String(item.actionType || '').trim().toLowerCase()
			if (type === 'close') type = 'press_escape'
			return {
				...item,
				actionType: type,
			}
		})
}

function isSafeVisionAction(action) {
	if (!action || !action.safe) return false
	if (action.status !== 'actionable') return false
	if (!['click_text', 'click_selector', 'remove_selector', 'press_escape'].includes(action.actionType)) return false

	if (action.actionType === 'click_text') {
		const text = normalizeText(action.targetText)
		if (!text) return false
		if (UNSAFE_CLICK_TEXTS.some(v => text.includes(v))) return false
		return SAFE_CLICK_TEXTS.some(v => text.includes(v))
	}

	if (action.actionType === 'press_escape') {
		return true
	}

	if (action.actionType === 'click_selector' || action.actionType === 'remove_selector') {
		const selector = String(action.cssSelector || '').trim()
		if (!selector || selector.length > 200) return false
		return /(cookie|consent|privacy|gdpr|onetrust|sp_message|overlay|modal|dialog|close|dismiss|paywall|piano|popup|popover|interstitial|newsletter|subscribe|advert|ad-modal|ad_overlay)/i.test(selector)
	}

	return false
}

async function applyVisionAction(page, action) {
	let actions = normalizeVisionActions(action)
	let applied = 0

	for (let step of actions) {
		if (!isSafeVisionAction(step)) continue
		if (step.actionType === 'press_escape') {
			await pressEscape(page)
			applied++
			continue
		}

		if (step.actionType === 'click_text') {
			const target = [normalizeText(step.targetText)]
			let clicks = 0
			for (const frame of page.frames()) {
				clicks += await clickByTextInFrame(frame, target)
			}
			if (clicks > 0) applied += clicks
			continue
		}

		if (step.actionType === 'click_selector') {
			const selector = [String(step.cssSelector || '').trim()]
			let clicks = 0
			for (const frame of page.frames()) {
				clicks += await clickBySelectorInFrame(frame, selector)
			}
			if (clicks > 0) applied += clicks
			continue
		}

		if (step.actionType === 'remove_selector') {
			const selector = [String(step.cssSelector || '').trim()]
			let removed = 0
			for (const frame of page.frames()) {
				removed += await removeBySelectorInFrame(frame, selector)
			}
			if (removed > 0) applied += removed
		}
	}

	if (applied > 0) {
		await waitDom(page, 5000)
		await page.waitForTimeout(600)
	}
	return applied
}

async function applyKnownFixes(page, startedAt) {
	assertBudget(startedAt, 'known_fix')
	let actions = 0
	await pressEscape(page)
	actions += await clickKnownConsentButtons(page)
	actions += (await removeKnownOverlays(page)) > 0 ? 1 : 0
	actions += (await removeHeuristicBlockers(page)) > 0 ? 1 : 0
	if (actions > 0) {
		await waitDom(page, 5000)
		await page.waitForTimeout(600)
	}
	return actions
}

async function captureOne(context, { index, url }) {
	const startedAt = Date.now()
	let page
	try {
		page = await context.newPage()
		log('  goto...')
		assertBudget(startedAt, 'goto')
		await page.goto(url, { waitUntil: 'commit', timeout: GOTO_TIMEOUT_MS })
		log('  wait domcontentloaded...')
		await waitDom(page)
		await page.waitForTimeout(1200)

		let check = await inspectPage(page, HEALTH_POLICIES.direct)
		log(`  health: ok=${check.ok ? 'yes' : 'no'} issue=${check.issueType} reason=${check.reason}`)

		for (let pass = 0; pass < KNOWN_FIX_PASSES && !check.ok; pass++) {
			const actions = await applyKnownFixes(page, startedAt)
			check = await inspectPage(page, HEALTH_POLICIES.direct)
			log(`  health after known-fix #${pass + 1}: ok=${check.ok ? 'yes' : 'no'} issue=${check.issueType}`)
			if (!actions) break
		}

		if (!check.ok && (check.issueType === 'consent' || check.issueType === 'overlay' || check.reason === 'consent_like_unknown')) {
			const removed = await forceRemoveBlockingLayers(page)
			if (removed > 0) {
				await waitDom(page, 5000)
				await page.waitForTimeout(500)
				check = await inspectPage(page, HEALTH_POLICIES.direct)
				log(`  health after force-clean: ok=${check.ok ? 'yes' : 'no'} issue=${check.issueType} reason=${check.reason}`)
			}
		}

		if (!check.ok && shouldUseVisionFallback(check)) {
			log('  unresolved, asking GPT vision...')
			try {
				const action = await askVisionAction(page, { url, check })
				if (action) {
					let actions = normalizeVisionActions(action)
					let actionLabel = actions.length
						? actions.map(a => a.actionType || 'none').join(',')
						: (action.actionType || 'none')
					log(`  gpt: status=${action.status || ''} issue=${action.issueType || ''} action=${actionLabel} safe=${action.safe ? 'yes' : 'no'}`)
					const applied = await applyVisionAction(page, action)
					if (applied > 0) {
						check = await inspectPage(page, HEALTH_POLICIES.direct)
						log(`  health after gpt action: ok=${check.ok ? 'yes' : 'no'} issue=${check.issueType}`)
					} else {
						const aiIssueType = normalizeText(action.issueType || '')
						const aiStatus = normalizeText(action.status || '')
						const aiReason = normalizeText(action.reason || '')
						if (
							aiIssueType.includes('captcha')
							|| aiIssueType.includes('security')
							|| aiIssueType.includes('verification')
							|| aiReason.includes('captcha')
							|| aiReason.includes('security')
							|| aiReason.includes('verification')
							|| aiReason.includes('access_denied')
							|| aiReason.includes('access denied')
							|| aiReason.includes('blocked')
						) {
							check = { ...check, issueType: 'captcha', reason: 'captcha_from_gpt' }
						} else if (
							aiIssueType.includes('paywall')
							|| aiIssueType.includes('subscribe')
							|| aiReason.includes('paywall')
							|| aiReason.includes('subscribe')
						) {
							check = { ...check, issueType: 'paywall', reason: 'paywall_from_gpt' }
						} else if (aiIssueType.includes('overlay')) {
							check = { ...check, issueType: 'overlay', reason: 'overlay_from_gpt' }
						} else if (aiIssueType.includes('consent')) {
							check = { ...check, issueType: 'consent', reason: 'consent_from_gpt' }
						} else if (aiStatus.includes('error')) {
							check = { ...check, issueType: 'unknown', reason: 'gpt_unresolved_error' }
						}
					}
				}
			} catch (e) {
				log(`  gpt vision error: ${String(e?.message || e)}`)
				check = { ...check, reason: 'gpt_vision_error' }
			}
		}

		if (!check.ok) {
			check = await applyBrightDataFallback(page, { url, check, startedAt })
		}

		if (!check.ok) {
			throw new Error(`health_check_failed issue=${check.issueType} reason=${check.reason}`)
		}

		const filePath = join(IMG_DIR, `${index}.jpg`)
		let preCleanupImage = null
		try {
			assertBudget(startedAt, 'pre_cleanup_capture')
			preCleanupImage = await page.screenshot({ type: 'jpeg', quality: 90 })
		} catch (e) {
			log(`  pre-clean capture skipped: ${String(e?.message || e)}`)
		}
		if (check.reason === 'brightdata_screenshot_loaded') {
			log('  brightdata screenshot frame ready, skipping cleanup checks')
			if (preCleanupImage) {
				await writeFile(filePath, preCleanupImage)
			} else {
				assertBudget(startedAt, 'screenshot')
				await page.screenshot({ path: filePath, type: 'jpeg', quality: 90 })
			}
			return { ok: true }
		}

		log('  cleanup + align...')
		await cleanupCosmetic(page)
		await alignToContent(page)
		await waitDom(page, 5000)
		await page.waitForTimeout(400)
		let postCheck = await inspectPage(page, HEALTH_POLICIES.direct)
		log(`  health after cleanup: ok=${postCheck.ok ? 'yes' : 'no'} issue=${postCheck.issueType} reason=${postCheck.reason}`)
		if (!postCheck.ok && postCheck.reason === 'document_unavailable') {
			await page.waitForTimeout(1200)
			postCheck = await inspectPage(page, HEALTH_POLICIES.direct)
			log(`  health after cleanup retry: ok=${postCheck.ok ? 'yes' : 'no'} issue=${postCheck.issueType} reason=${postCheck.reason}`)
		}
		if (!postCheck.ok) {
			const actions = await applyKnownFixes(page, startedAt)
			if (actions > 0) {
				postCheck = await inspectPage(page, HEALTH_POLICIES.direct)
				log(`  health after post-clean known-fix: ok=${postCheck.ok ? 'yes' : 'no'} issue=${postCheck.issueType} reason=${postCheck.reason}`)
				if (!postCheck.ok && postCheck.reason === 'document_unavailable') {
					await page.waitForTimeout(1200)
					postCheck = await inspectPage(page, HEALTH_POLICIES.direct)
					log(`  health after post-clean retry: ok=${postCheck.ok ? 'yes' : 'no'} issue=${postCheck.issueType} reason=${postCheck.reason}`)
				}
			}
		}
		if (!postCheck.ok && (postCheck.issueType === 'consent' || postCheck.issueType === 'overlay' || postCheck.reason === 'consent_like_unknown')) {
			const removed = await forceRemoveBlockingLayers(page)
			if (removed > 0) {
				await waitDom(page, 5000)
				await page.waitForTimeout(500)
				postCheck = await inspectPage(page, HEALTH_POLICIES.direct)
				log(`  health after post-clean force-clean: ok=${postCheck.ok ? 'yes' : 'no'} issue=${postCheck.issueType} reason=${postCheck.reason}`)
			}
		}
		if (postCheck.ok && postCheck.hasSkeletonSignals) {
			log('  post-cleanup skeleton detected, waiting extra render...')
			const preSkeletonCheck = postCheck
			await page.waitForTimeout(1800)
			await waitDom(page, 5000)
			postCheck = await inspectPage(page, HEALTH_POLICIES.direct)
			log(`  health after skeleton wait: ok=${postCheck.ok ? 'yes' : 'no'} issue=${postCheck.issueType} reason=${postCheck.reason}`)
			if (!postCheck.ok) {
				log('  skeleton wait degraded frame, using pre-skeleton state')
				postCheck = preSkeletonCheck
			}
		}
		if (!postCheck.ok) {
			if (preCleanupImage) {
				const preCleanupQuality = assessFinalFrameQuality(check)
				if (preCleanupQuality.ok) {
					log(`  cleanup degraded frame, using pre-clean screenshot issue=${postCheck.issueType} reason=${postCheck.reason}`)
					await writeFile(filePath, preCleanupImage)
					return { ok: true }
				}
			}
			throw new Error(`health_check_failed issue=${postCheck.issueType} reason=${postCheck.reason}`)
		}

		const finalQuality = assessFinalFrameQuality(postCheck)
		log(
			`  checklist source=${postCheck.hasSourceVisible ? 'yes' : 'no'}` +
			` headline=${postCheck.hasHeadlineVisible ? 'yes' : 'no'}` +
			` subtitle=${postCheck.hasSubtitleVisible ? 'yes' : 'no'}` +
			` date=${postCheck.hasDateVisible ? 'yes' : 'no'}` +
			` byline=${postCheck.hasBylineVisible ? 'yes' : 'no'}` +
			` image=${postCheck.hasImageVisible ? 'yes' : 'no'}` +
			` text=${postCheck.hasLeadTextVisible ? 'yes' : 'no'}` +
			` overlay=${postCheck.hasBlockingOverlay ? 'yes' : 'no'}`
		)
		if (finalQuality.warnings?.length) {
			log(`  checklist warning: ${finalQuality.warnings.join(',')}`)
		}
		if (!finalQuality.ok) {
			log(`  final quality: fail reason=${finalQuality.reason}`)
			if (preCleanupImage) {
				const preCleanupQuality = assessFinalFrameQuality(check)
				if (preCleanupQuality.ok) {
					log(`  using pre-clean screenshot due better quality (${preCleanupQuality.reason})`)
					await writeFile(filePath, preCleanupImage)
					return { ok: true }
				}
			}
			throw new Error(`health_check_failed issue=quality reason=${finalQuality.reason}`)
		}

		assertBudget(startedAt, 'screenshot')
		log('  save screenshot...')
		await page.screenshot({ path: filePath, type: 'jpeg', quality: 90 })
		return { ok: true }
	} catch (e) {
		return { ok: false, error: String(e?.message || e) }
	} finally {
		if (page) {
			try { await page.close() } catch {}
		}
	}
}

async function saveScreenshotFailures(failures) {
	if (!Array.isArray(failures) || failures.length === 0) return
	if (!screenshotLogsSpreadsheetId) return

	try {
		await ensureSheet(screenshotLogsSpreadsheetId, screenshotLogsSheet)
		let headerRange = `${screenshotLogsSheet}!A1:J1`
		let headerRows = await load(screenshotLogsSpreadsheetId, headerRange)
		let header = Array.isArray(headerRows?.[0]) ? headerRows[0].map(v => String(v || '').trim()) : []
		let hasValidHeader = SCREENSHOT_LOG_HEADERS.every((name, i) => header[i] === name)
		if (!hasValidHeader) {
			await save(screenshotLogsSpreadsheetId, headerRange, [SCREENSHOT_LOG_HEADERS])
		}

		let rows = failures.map(f => ([
			f.ts || new Date().toISOString(),
			String(f.sqk || ''),
			String(f.source || ''),
			String(f.domain || ''),
			String(f.url || ''),
			String(f.issue || ''),
			String(f.reason || ''),
			String(f.error || ''),
			String(f.urlField || ''),
			String(f.title || ''),
		]))
		await append(screenshotLogsSpreadsheetId, `${screenshotLogsSheet}!A:J`, rows)
		log(`Screenshot failures logged: ${rows.length} row(s) -> ${screenshotLogsSheet}`)
	} catch (e) {
		log('Failed to save screenshot failures log\n', e)
	}
}

export async function screenshots() {
	let content
	let fileMeta = null
	try {
		content = await readFile(SCREENSHOTS_FILE, 'utf-8')
		fileMeta = await stat(SCREENSHOTS_FILE).catch(() => null)
	} catch {
		log('No screenshots.txt found')
		logRunTotalCost({ task: 'screenshots', logger: log })
		return
	}

	let lines = content.trim().split('\n').filter(l => l.trim())
	let items = []
	let metadataLineCount = 0
	for (let i = 0; i < lines.length; i += 2) {
		let index = lines[i].trim()
		let rawLine = String(lines[i + 1] || '').trim()
		if (rawLine.includes('||')) metadataLineCount++
		let parsed = parseScreenshotLine(rawLine)
		if (index && parsed.url) {
			items.push({
				index,
				url: parsed.url,
				source: String(parsed.meta.source || '').trim(),
				title: String(parsed.meta.title || '').trim(),
				urlField: String(parsed.meta.url_field || '').trim(),
				rowId: String(parsed.meta.row_id || '').trim(),
				rawUrl: String(parsed.meta.raw_url || '').trim(),
				rawUsedUrl: String(parsed.meta.raw_used_url || '').trim(),
			})
		}
	}

	if (items.length === 0) {
		log('No screenshots to take')
		logRunTotalCost({ task: 'screenshots', logger: log })
		return
	}

	if (metadataLineCount === 0 && !ALLOW_LEGACY_SCREENSHOTS_LIST) {
		let modifiedAt = fileMeta?.mtime ? new Date(fileMeta.mtime).toISOString() : 'unknown'
		throw new Error(
			`Legacy screenshots.txt detected (no metadata markers, modified=${modifiedAt}). ` +
			`Run \"npm run slides\" before \"npm run screenshots\". ` +
			`Set SCREENSHOTS_ALLOW_LEGACY_LIST=1 to override.`
		)
	}

	let groupedByUrl = new Map()
	for (let item of items) {
		let key = String(item.url || '').trim()
		if (!key) continue
		let bucket = groupedByUrl.get(key)
		if (!bucket) {
			bucket = []
			groupedByUrl.set(key, bucket)
		}
		bucket.push(item)
	}
	let duplicateGroups = [...groupedByUrl.entries()].filter(([, group]) => group.length > 1)
	if (duplicateGroups.length > 0) {
		let duplicateRows = duplicateGroups.reduce((sum, [, group]) => sum + group.length, 0)
		log(`SCREENSHOTS_DUP_URL groups=${duplicateGroups.length} rows=${duplicateRows}`)
		for (let [url, group] of duplicateGroups) {
			log(`SCREENSHOTS_DUP_URL url=${url} count=${group.length}`)
			for (let item of group) {
				log(
					'  row',
					`sqk=${item.index}`,
					`row_id=${item.rowId || ''}`,
					`source=${item.source || ''}`,
					`title=${item.title || ''}`,
					`url_field=${item.urlField || ''}`,
					`raw_url=${item.rawUrl || ''}`,
					`raw_used_url=${item.rawUsedUrl || ''}`,
				)
			}
		}
	}

	log(`Taking ${items.length} screenshots...`)
	log(`Screenshot flow: known-fix${ENABLE_VISION_FALLBACK ? ' + gpt-fallback' : ''} + ${describeBrightDataUnlockerSettings()}`)

	let browser = await firefox.launch({ headless: true })
	let context = await browser.newContext({
		viewport: { width: 1920, height: 1080 },
		deviceScaleFactor: 1,
		locale: 'en-US',
	})

	const stats = {
		total: items.length,
		ok: 0,
		fail: 0,
		byIssue: {},
	}
	let failures = []

	for (const item of items) {
		const stalePath = join(IMG_DIR, `${item.index}.jpg`)
		try {
			await unlink(stalePath)
		} catch (e) {
			if (e?.code !== 'ENOENT') {
				log(`Failed to remove stale screenshot ${item.index}: ${String(e?.message || e)}`)
			}
		}
	}

	for (const item of items) {
		log(`[${item.index}] ${item.url}${item.source ? ` (${item.source})` : ''}`)
		let result
		try {
			result = await captureOne(context, item)
		} catch (e) {
			result = { ok: false, error: String(e?.message || e) }
		}
		if (!result.ok) {
			const error = String(result.error || '')
			log(`  Error: ${error}`)
			const failedPath = join(IMG_DIR, `${item.index}.jpg`)
			try {
				await unlink(failedPath)
			} catch (e) {
				if (e?.code !== 'ENOENT') {
					log(`Failed to remove failed screenshot ${item.index}: ${String(e?.message || e)}`)
				}
			}

			const { issue, reason } = extractIssueReason(error)
			stats.fail++
			stats.byIssue[issue] = (stats.byIssue[issue] || 0) + 1
			failures.push({
				ts: new Date().toISOString(),
				sqk: item.index,
				source: item.source,
				domain: hostFromUrl(item.url),
				url: item.url,
				issue,
				reason,
				error,
				urlField: item.urlField,
				title: item.title,
			})
		} else {
			stats.ok++
		}
	}

	await browser.close()
	await saveScreenshotFailures(failures)
	const issueParts = Object.entries(stats.byIssue)
		.map(([k, v]) => `${k}=${v}`)
		.join(' ')
	log(`Screenshots done. total=${stats.total} ok=${stats.ok} fail=${stats.fail}${issueParts ? ` ${issueParts}` : ''}`)
	logRunTotalCost({ task: 'screenshots', logger: log })
}

if (process.argv[1]?.includes('screenshots')) screenshots()
