const fs = require("fs");
const path = require("path");

const inputFile = path.join(
    __dirname,
    "data",
    "nankai",
    "vehicle-list.txt"
);

const outputFile = path.join(
    __dirname,
    "data",
    "nankai",
    "vehicles.json"
);

function clean(value) {
    return String(value ?? "").trim();
}

function normalizeVehicleNum(value) {
    const digits = clean(value).replace(/\D/g, "");

    if (!digits) {
        return "";
    }

    return digits.padStart(6, "0");
}

function readExistingVehicles() {
    try {
        return JSON.parse(
            fs.readFileSync(outputFile, "utf8")
        );
    } catch {
        return {};
    }
}

if (!fs.existsSync(inputFile)) {
    console.error(
        "vehicle-list.txtが見つかりません:",
        inputFile
    );
    process.exit(1);
}

const text = fs
    .readFileSync(inputFile, "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");

const existing = readExistingVehicles();
const vehicles = {};

let current = {};

function saveCurrent() {
    const vehicleNum =
        normalizeVehicleNum(current.vehicleNum);

    if (!vehicleNum) {
        current = {};
        return;
    }

    const oldVehicle =
        existing[vehicleNum] || {};

    vehicles[vehicleNum] = {
        vehicleNum,
        company: "nankai",

        registration:
            clean(current.registration) ||
            clean(oldVehicle.registration),

        office:
            clean(current.office) ||
            clean(oldVehicle.office),

        model:
            clean(current.model) ||
            clean(oldVehicle.model),

        note:
            clean(current.note) ||
            clean(oldVehicle.note),

        marked:
            Boolean(oldVehicle.marked)
    };

    current = {};
}

for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();

    if (!line) {
        saveCurrent();
        continue;
    }

    const match = line.match(
        /^([^：:]+)[：:]\s*(.*)$/
    );

    if (!match) {
        continue;
    }

    const label = clean(match[1]);
    const value = clean(match[2]);

    if (
        label === "車番" ||
        label === "車両番号"
    ) {
        if (current.vehicleNum) {
            saveCurrent();
        }

        current.vehicleNum = value;
    } else if (label === "車種") {
        /*
         * 車種名は現在のvehicles.jsonでは
         * 保存していないため、今回は読み飛ばす。
         * 車種表示は型式から自動判定される。
         */
        current.busType = value;
    } else if (label === "型式") {
        current.model = value;
    } else if (label === "所属") {
        current.office = value;
    } else if (
        label === "登録番号" ||
        label === "ナンバー"
    ) {
        current.registration = value;
    } else if (
        label === "備考" ||
        label === "注記"
    ) {
        current.note = value;
    }
}

saveCurrent();

/*
 * TXTに載っていない既存車両も消さない。
 */
for (const [vehicleNum, vehicle] of
    Object.entries(existing)) {
    if (!vehicles[vehicleNum]) {
        vehicles[vehicleNum] = vehicle;
    }
}

const sortedVehicles = Object.fromEntries(
    Object.entries(vehicles).sort(
        ([a], [b]) =>
            a.localeCompare(b, "ja")
    )
);

const backupFile =
    outputFile + ".backup";

if (fs.existsSync(outputFile)) {
    fs.copyFileSync(
        outputFile,
        backupFile
    );

    console.log(
        "バックアップ作成:",
        backupFile
    );
}

fs.writeFileSync(
    outputFile,
    JSON.stringify(
        sortedVehicles,
        null,
        2
    ) + "\n",
    "utf8"
);

console.log(
    `変換完了：${Object.keys(sortedVehicles).length}台`
);

console.log(
    "出力先:",
    outputFile
);
