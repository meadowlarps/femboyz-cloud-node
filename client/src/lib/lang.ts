let currentLang = "en";
let availableLangs = ["en", "ru"];
let langData: Record<string, string> = {};

export async function loadLang(lang: string) {
    if (!availableLangs.includes(lang)) {
        console.warn(`Language ${lang} is not available, not changing.`);
        return;
    }
    currentLang = lang;
    langData = await import(`./lang/${currentLang}.json`);
}

function getAvailableLangs() {
    return availableLangs;
}

export function t(key: string) {
    return langData[key] || key;
}

export function setLang(lang: string) {
    currentLang = lang;
}

export function getLang() {
    return currentLang;
}