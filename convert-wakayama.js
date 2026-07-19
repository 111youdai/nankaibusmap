const fs = require("fs");
const path = require("path");

const INPUT = path.join(__dirname, "data", "wakayama", "vehicle-list.txt");
const OUTPUT = path.join(__dirname, "data", "wakayama", "vehicles.json");
const BACKUP = OUTPUT + ".backup";

let vehicles = {};

if (fs.existsSync(OUTPUT)) {
    fs.copyFileSync(OUTPUT, BACKUP);
    console.log("バックアップ作成:", BACKUP);
}

const lines = fs.readFileSync(INPUT, "utf8").split(/\r?\n/);

let category = "";

for (const raw of lines) {
    const line = raw.trim();

    if (!line) continue;

    // カテゴリ行
    if (!/^\d/.test(line)) {
        category = line;
        continue;
    }

    const match = line.match(/^(\d+)\s+(\S+)\s+(.+)$/);

    if (!match) continue;

    const vehicleNum = match[1];
    const registration = match[2];
    const rest = match[3];

    const parts = rest.split(/\s+/);

    let typeIndex = parts.findIndex(p => /^[A-Z0-9-]+$/.test(p) && p.includes("-"));

    let model = "";
    let type = "";
    let note = "";

    if (typeIndex >= 0) {
        model = parts.slice(0, typeIndex).join(" ");
        type = parts[typeIndex];
        note = parts.slice(typeIndex + 1).join(" ");
    } else {
        model = rest;
    }

    vehicles[vehicleNum] = {
        company: "和歌山バス",
        registration,
        category,
        model,
        type,
        note,
        marked: false
    };
}

const sorted = Object.fromEntries(
    Object.entries(vehicles).sort((a, b) => Number(a[0]) - Number(b[0]))
);

fs.writeFileSync(
    OUTPUT,
    JSON.stringify(sorted, null, 2),
    "utf8"
);

console.log(`変換完了：${Object.keys(sorted).length}台`);
console.log("出力先:", OUTPUT);
