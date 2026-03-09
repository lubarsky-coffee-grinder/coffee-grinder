export let restricted = [
	// paywall
	'The Wall Street Journal',
	'The New York Times',
	'The Washington Post',
	'Financial Times',
	'CNN',
	'Ground News',
	'Bloomberg',
	'Daily Wire',
	'Le Monde',
	// scrapping issues
	'Reuters',
	'POLITICO',
	'The Hill',
	'Axios',
	'Fortune',
]

export const agencyDomains = {
	'Associated Press': ['apnews.com'],
	'AP News': ['apnews.com'],
	'Reuters': ['reuters.com'],
	'Bloomberg': ['bloomberg.com'],
	'Financial Times': ['ft.com'],
	'The Wall Street Journal': ['wsj.com'],
	'The New York Times': ['nytimes.com'],
	'The Washington Post': ['washingtonpost.com'],
	'BBC': ['bbc.com', 'bbc.co.uk'],
	'The Guardian': ['theguardian.com'],
	'Al Jazeera': ['aljazeera.com'],
	'NPR': ['npr.org'],
	'PBS NewsHour': ['pbs.org'],
	'CNN': ['cnn.com'],
	'Fox News': ['foxnews.com'],
	'Fox Business': ['foxbusiness.com'],
	'CNBC': ['cnbc.com'],
	'POLITICO': ['politico.com'],
	'Axios': ['axios.com'],
	'USA TODAY': ['usatoday.com'],
	'ABC News': ['abcnews.go.com'],
	'CBS News': ['cbsnews.com'],
	'NBC News': ['nbcnews.com'],
	'Time': ['time.com'],
	'Newsweek': ['newsweek.com'],
	'Fortune': ['fortune.com'],
	'The Hill': ['thehill.com'],
	'New York Post': ['nypost.com'],
	'Observer': ['observer.com'],
	'MarketWatch': ['marketwatch.com'],
	"Barron's": ['barrons.com'],
	'ProPublica': ['propublica.org'],
	'Los Angeles Times': ['latimes.com'],
	'Chicago Tribune': ['chicagotribune.com'],
	'The Boston Globe': ['bostonglobe.com'],
	'The Dallas Morning News': ['dallasnews.com'],
	'San Francisco Chronicle': ['sfchronicle.com'],
	'The Philadelphia Inquirer': ['inquirer.com'],
	'The Atlanta Journal-Constitution': ['ajc.com'],
	'Detroit News': ['detroitnews.com'],
	'The Miami Herald': ['miamiherald.com'],
	'The Seattle Times': ['seattletimes.com'],
	'Kansas City Star': ['kansascity.com'],
	'TechCrunch': ['techcrunch.com'],
	'Le Monde': ['lemonde.fr'],
	'Der Spiegel': ['spiegel.de'],
	'France 24': ['france24.com'],
	'Euronews': ['euronews.com'],
	'South China Morning Post': ['scmp.com'],
}

export function resolveAgencyFromUrl(url) {
	if (!url) return ''
	try {
		let host = new URL(String(url).trim()).hostname.toLowerCase().replace(/^www\./, '')
		for (let [agencyName, domains] of Object.entries(agencyDomains)) {
			for (let domain of domains || []) {
				let normalized = String(domain || '').toLowerCase()
				if (!normalized) continue
				if (host === normalized || host.endsWith(`.${normalized}`)) return agencyName
			}
		}
		return host
	} catch {
		return ''
	}
}
