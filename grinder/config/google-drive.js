import { readEnv } from '../src/env.js'

export let rootFolderId = readEnv('GOOGLE_ROOT_FOLDER_ID')
export let mainSpreadsheetId = readEnv('GOOGLE_SHEET_ID_MAIN')
export let autoSpreadsheetId = readEnv('GOOGLE_SHEET_ID_AUTO')
export let newsSheet = 'news'
export let screenshotLogsSheet = 'screenshot_logs'
export let aiSheet = 'ai-instructions'
export let promptsSheet = 'prompts'
export let templatePresentationId = readEnv('GOOGLE_TEMPLATE_PRESENTATION_ID')
export let templateSlideId = readEnv('GOOGLE_TEMPLATE_SLIDE_ID')
export let templateTableId = readEnv('GOOGLE_TEMPLATE_TABLE_ID')
export let presentationName = readEnv('GOOGLE_PRESENTATION_NAME')
export let autoPresentationName = readEnv('GOOGLE_AUTO_PRESENTATION_NAME') || presentationName
export let audioFolderName = 'audio'
export let imageFolderName = 'img'
export let archiveFolderId = '1pNa15MULvOIaGqeQAYfxN9e7FX5cLlgR'
export let autoArchiveFolderId = '17OlCbhRNhkLYSL6aKYMAr_d2oazw_RaX'
