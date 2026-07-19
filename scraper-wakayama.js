const axios = require("axios");
const AdmZip = require("adm-zip");
const { parse } = require("csv-parse/sync");
const GtfsRealtimeBindings = require("gtfs-realtime-bindings");
const fs = require("fs");
const path = require("path");

const OUTPUT_DIR = path.join(__dirname, "data", "wakayama");
const GPS_FILE = path.join(OUTPUT_DIR, "gps.json");
const VEHICLES_FILE = path.join(OUTPUT_DIR, "vehicles.json");
const CACHE_DIR = path.join(__dirname, ".cache", "wakayama-gtfs");

/*
 * 和歌山バス＋和歌山バス那賀
 *
 * staticUrl は時刻表・路線名・停留所名の取得用、
 * vehiclePositionUrl は現在位置の取得用。
 */
const COMPANIES = [
    {
        id: "wakayama",
        name: "和歌山バス",
        staticUrl:
            "https://loc.bus-vision.jp/gtfs/wakayama/gtfsFeed",
        vehiclePositionUrl:
            "https://loc.bus-vision.jp/realtime/wakayama_vpos_update.bin"
    },
    {
        id: "wakayama-naga",
        name: "和歌山バス那賀",
        staticUrl:
            "https://loc.bus-vision.jp/gtfs_v2/wakayamabusnaga/gtfsFeed",
        vehiclePositionUrl:
            "https://loc.bus-vision.jp/realtime/wakayamabusnaga_vpos_update_v2.bin"
    }
];

const HTTP_OPTIONS = {
    timeout: 30000,
    headers: {
        "User-Agent":
            "nankaibusmap/1.0 (personal transit map; low-frequency access)"
    }
};

function ensureDirectories() {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function readJsonIfExists(filePath, fallback) {
    try {
        return JSON.parse(
            fs.readFileSync(filePath, "utf8")
        );
    } catch {
        return fallback;
    }
}

function writeJsonAtomic(filePath, value) {
    const temporaryPath = `${filePath}.tmp`;

    fs.writeFileSync(
        temporaryPath,
        JSON.stringify(value, null, 2) + "\n",
        "utf8"
    );

    fs.renameSync(temporaryPath, filePath);
}

function formatJst(timestampSeconds = Date.now() / 1000) {
    const date = new Date(Number(timestampSeconds) * 1000);

    return new Intl.DateTimeFormat("ja-JP", {
        timeZone: "Asia/Tokyo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
    })
        .format(date)
        .replace(/\//g, "/");
}

function normalizeText(value) {
    return String(value ?? "").trim();
}

function csvFromZip(zip, filename) {
    const entry = zip.getEntry(filename);

    if (!entry) {
        throw new Error(
            `${filename} がGTFS ZIP内にありません`
        );
    }

    return parse(entry.getData().toString("utf8"), {
        columns: true,
        skip_empty_lines: true,
        bom: true,
        relax_column_count: true
    });
}

async function downloadStaticGtfs(company) {
    const zipPath = path.join(
        CACHE_DIR,
        `${company.id}.zip`
    );

    try {
        const response = await axios.get(
            company.staticUrl,
            {
                ...HTTP_OPTIONS,
                responseType: "arraybuffer"
            }
        );

        fs.writeFileSync(
            zipPath,
            Buffer.from(response.data)
        );

        console.log(
            `${company.name}: 静的GTFSを更新`
        );
    } catch (error) {
        if (!fs.existsSync(zipPath)) {
            throw error;
        }

        console.warn(
            `${company.name}: 静的GTFSの更新に失敗したため` +
            "キャッシュを使用します",
            error.message
        );
    }

    return zipPath;
}

function buildStaticIndexes(zipPath) {
    const zip = new AdmZip(zipPath);

    const routes = csvFromZip(zip, "routes.txt");
    const trips = csvFromZip(zip, "trips.txt");
    const stops = csvFromZip(zip, "stops.txt");
    const stopTimes = csvFromZip(
        zip,
        "stop_times.txt"
    );

    const routeById = new Map();
    const tripById = new Map();
    const stopById = new Map();
    const stopIdsByTripId = new Map();

    for (const route of routes) {
        routeById.set(
            normalizeText(route.route_id),
            route
        );
    }

    for (const trip of trips) {
        tripById.set(
            normalizeText(trip.trip_id),
            trip
        );
    }

    for (const stop of stops) {
        const lat = Number(stop.stop_lat);
        const lon = Number(stop.stop_lon);

        if (
            Number.isFinite(lat) &&
            Number.isFinite(lon)
        ) {
            stopById.set(
                normalizeText(stop.stop_id),
                {
                    id: normalizeText(stop.stop_id),
                    name:
                        normalizeText(stop.stop_name) ||
                        "停留所名不明",
                    lat,
                    lon
                }
            );
        }
    }

    for (const stopTime of stopTimes) {
        const tripId =
            normalizeText(stopTime.trip_id);
        const stopId =
            normalizeText(stopTime.stop_id);

        if (!stopIdsByTripId.has(tripId)) {
            stopIdsByTripId.set(tripId, []);
        }

        stopIdsByTripId.get(tripId).push({
            stopId,
            sequence:
                Number(stopTime.stop_sequence) || 0
        });
    }

    for (const items of stopIdsByTripId.values()) {
        items.sort(
            (a, b) => a.sequence - b.sequence
        );
    }

    return {
        routeById,
        tripById,
        stopById,
        stopIdsByTripId
    };
}

function distanceSquared(lat1, lon1, lat2, lon2) {
    const latitudeScale = 111;
    const longitudeScale =
        111 * Math.cos((lat1 * Math.PI) / 180);

    const dy = (lat2 - lat1) * latitudeScale;
    const dx = (lon2 - lon1) * longitudeScale;

    return dx * dx + dy * dy;
}

function findNearestTripStop(
    tripId,
    lat,
    lon,
    indexes
) {
    const tripStops =
        indexes.stopIdsByTripId.get(tripId) || [];

    let nearest = null;
    let nearestDistance = Infinity;

    for (const item of tripStops) {
        const stop =
            indexes.stopById.get(item.stopId);

        if (!stop) {
            continue;
        }

        const distance = distanceSquared(
            lat,
            lon,
            stop.lat,
            stop.lon
        );

        if (distance < nearestDistance) {
            nearestDistance = distance;
            nearest = stop;
        }
    }

    /*
     * GTFS-RTにtrip_idが無い場合などは、
     * 全停留所から一番近いものを探す。
     */
    if (!nearest) {
        for (const stop of indexes.stopById.values()) {
            const distance = distanceSquared(
                lat,
                lon,
                stop.lat,
                stop.lon
            );

            if (distance < nearestDistance) {
                nearestDistance = distance;
                nearest = stop;
            }
        }
    }

    return nearest;
}

function getRouteName(tripId, indexes) {
    const trip = indexes.tripById.get(tripId);

    if (!trip) {
        return "路線不明";
    }

    const route = indexes.routeById.get(
        normalizeText(trip.route_id)
    );

    if (!route) {
        return (
            normalizeText(trip.trip_headsign) ||
            "路線不明"
        );
    }

    const routeName =
        normalizeText(route.route_long_name) ||
        normalizeText(route.route_short_name);

    const destination =
        normalizeText(trip.trip_headsign);

    if (
        routeName &&
        destination &&
        !routeName.includes(destination)
    ) {
        return `${routeName}（${destination}行き）`;
    }

    return (
        routeName ||
        destination ||
        "路線不明"
    );
}

async function downloadVehiclePositions(company) {
    const response = await axios.get(
        company.vehiclePositionUrl,
        {
            ...HTTP_OPTIONS,
            responseType: "arraybuffer"
        }
    );

    return GtfsRealtimeBindings.transit_realtime
        .FeedMessage.decode(
            new Uint8Array(response.data)
        );
}

function getVehicleNumber(vehicle, entityId) {
    return (
        normalizeText(vehicle?.vehicle?.label) ||
        normalizeText(vehicle?.vehicle?.id) ||
        normalizeText(entityId)
    );
}

async function loadCompany(company) {
    const zipPath =
        await downloadStaticGtfs(company);

    const indexes =
        buildStaticIndexes(zipPath);

    const feed =
        await downloadVehiclePositions(company);

    const buses = [];

    for (const entity of feed.entity) {
        const vehicle = entity.vehicle;

        if (!vehicle?.position) {
            continue;
        }

        const lat =
            Number(vehicle.position.latitude);
        const lon =
            Number(vehicle.position.longitude);

        if (
            !Number.isFinite(lat) ||
            !Number.isFinite(lon)
        ) {
            continue;
        }

        const tripId =
            normalizeText(vehicle.trip?.tripId);

        const vehicleNum =
            getVehicleNumber(vehicle, entity.id);

        const nearestStop =
            findNearestTripStop(
                tripId,
                lat,
                lon,
                indexes
            );

        const timestamp =
            Number(vehicle.timestamp) ||
            Number(feed.header?.timestamp) ||
            Math.floor(Date.now() / 1000);

        buses.push({
            company: company.id,
            companyName: company.name,
            vehicleNum,
            lat,
            lon,
            route: getRouteName(
                tripId,
                indexes
            ),
            stop:
                nearestStop?.name ||
                "現在地不明",
            tripId,
            bearing:
                Number.isFinite(
                    Number(vehicle.position.bearing)
                )
                    ? Number(vehicle.position.bearing)
                    : null,
            speed:
                Number.isFinite(
                    Number(vehicle.position.speed)
                )
                    ? Number(vehicle.position.speed)
                    : null,
            updateTime: formatJst(timestamp)
        });
    }

    console.log(
        `${company.name}: ${buses.length}台取得`
    );

    return buses;
}

function updateVehiclesFile(buses) {
    const existing = readJsonIfExists(
        VEHICLES_FILE,
        {}
    );

    for (const bus of buses) {
        if (!existing[bus.vehicleNum]) {
            existing[bus.vehicleNum] = {
                vehicleNum: bus.vehicleNum,
                company: bus.company,
                registration: "",
                office: "",
                model: "",
                note: "",
                marked: false
            };
        }
    }

    writeJsonAtomic(
        VEHICLES_FILE,
        existing
    );
}

async function main() {
    ensureDirectories();

    const settled = await Promise.allSettled(
        COMPANIES.map(loadCompany)
    );

    const allBuses = [];
    const errors = [];

    settled.forEach((result, index) => {
        if (result.status === "fulfilled") {
            allBuses.push(...result.value);
        } else {
            const company = COMPANIES[index];

            errors.push({
                company: company.name,
                message:
                    result.reason?.message ||
                    String(result.reason)
            });
        }
    });

    /*
     * 一方だけ取得に失敗した場合でも、
     * 取得できた会社のデータは保存する。
     * 両方失敗した場合は既存gps.jsonを壊さない。
     */
    if (allBuses.length === 0 && errors.length > 0) {
        throw new Error(
            errors
                .map(
                    item =>
                        `${item.company}: ${item.message}`
                )
                .join("\n")
        );
    }

    allBuses.sort((a, b) =>
        String(a.vehicleNum).localeCompare(
            String(b.vehicleNum),
            "ja"
        )
    );

    writeJsonAtomic(GPS_FILE, allBuses);
    updateVehiclesFile(allBuses);

    console.log(
        `data/wakayama/gps.jsonへ` +
        `${allBuses.length}台を保存しました`
    );

    if (errors.length > 0) {
        console.warn(
            "一部取得失敗:",
            errors
        );
    }
}

main().catch(error => {
    console.error(
        "和歌山バス取得エラー:",
        error
    );
    process.exitCode = 1;
});
