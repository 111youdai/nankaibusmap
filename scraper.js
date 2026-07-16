const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");

const BASE_URL = "https://loc.bus-vision.jp";
const VIEW_BASE_URL = `${BASE_URL}/nankai/view/`;
const SEARCH_URL = `${VIEW_BASE_URL}searchVehicle.html`;

const HEADERS = {
    "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 Chrome/150 Safari/537.36",
    "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ja,en-US;q=0.9,en;q=0.8"
};

// 検索結果のページ移動時の待機時間
const PAGE_WAIT_MS = 300;

// 同時にGPS取得する車両数
// 大きくしすぎると先方へ負荷がかかるため、まずは5台
const VEHICLE_CONCURRENCY = 5;

// 何台処理するごとに途中結果を保存するか
const SAVE_EVERY = 5;

// Cookieを簡易的に保存
let cookie = "";

/**
 * Set-CookieヘッダーからCookieを保存する
 */
function updateCookie(response) {
    const setCookies = response.headers["set-cookie"];

    if (!setCookies) {
        return;
    }

    const newCookies = setCookies.map(item =>
        item.split(";")[0]
    );

    const cookieMap = new Map();

    for (
        const item of cookie
            .split(";")
            .map(value => value.trim())
            .filter(Boolean)
    ) {
        const separator = item.indexOf("=");

        if (separator !== -1) {
            cookieMap.set(
                item.slice(0, separator),
                item.slice(separator + 1)
            );
        }
    }

    for (const item of newCookies) {
        const separator = item.indexOf("=");

        if (separator !== -1) {
            cookieMap.set(
                item.slice(0, separator),
                item.slice(separator + 1)
            );
        }
    }

    cookie = [...cookieMap.entries()]
        .map(([name, value]) => `${name}=${value}`)
        .join("; ");
}

/**
 * 共通POST処理
 */
async function postForm(
    url,
    params,
    referer = SEARCH_URL
) {
    const response = await axios.post(
        url,
        new URLSearchParams(params).toString(),
        {
            headers: {
                ...HEADERS,
                "Content-Type":
                    "application/x-www-form-urlencoded",
                "Referer": referer,
                ...(cookie
                    ? { Cookie: cookie }
                    : {})
            },
            maxRedirects: 5,
            timeout: 30000
        }
    );

    updateCookie(response);

    return response;
}

/**
 * 共通GET処理
 */
async function getHtml(
    url,
    referer = SEARCH_URL
) {
    const response = await axios.get(
        url,
        {
            headers: {
                ...HEADERS,
                "Referer": referer,
                ...(cookie
                    ? { Cookie: cookie }
                    : {})
            },
            maxRedirects: 5,
            timeout: 30000
        }
    );

    updateCookie(response);

    return response;
}

/**
 * HTML内のフォームactionを絶対URLに変換
 */
function getFormAction($, currentUrl) {
    const action =
        $("form#form").attr("action") ||
        $("form").first().attr("action") ||
        currentUrl;

    return new URL(
        action,
        currentUrl
    ).href;
}

/**
 * HTML内のte-conditionsを取得
 */
function getTeConditions(html) {
    const match = String(html).match(
        /name=['"]te-conditions['"]\s+value=['"]([^'"]+)['"]/
    );

    return match?.[1] || "";
}

/**
 * 現在の検索結果ページから、
 * 次ページ移動に必要なフォーム値を作る
 */
function createNextPageParams($, html) {
    const params = {
        "form:inputVehicleNum":
            $("#inputVehicleNum").val() || "0",

        "form:searchVehicleNum":
            $("#searchVehicleNum").val() || "0",

        "form:pageNo":
            $("#pageNo").val() || "1",

        "form:langItems":
            $("#langItems").val() || "0",

        "form/view/searchVehicle.html":
            "form",

        "form:doNextBottom":
            "次へ"
    };

    const teConditions =
        getTeConditions(html);

    if (teConditions) {
        params["te-conditions"] =
            teConditions;
    }

    return params;
}

/**
 * 1ページ分の車両を取り出す
 */
function extractBuses($) {
    const buses = [];

    $('a[href*="vehicleState.html"]')
        .each((_, el) => {
            const href =
                $(el).attr("href") || "";

            const text =
                $(el).text().trim();

            const vehicleCd =
                href.match(
                    /[?&]vehicleCd=(\d+)/
                )?.[1];

            const vehicleCorpCd =
                href.match(
                    /[?&]vehicleCorpCd=(\d+)/
                )?.[1];

            const vehicleNum =
                text.match(/\d{6}/)?.[0];

            if (
                vehicleCd &&
                vehicleCorpCd &&
                vehicleNum
            ) {
                buses.push({
                    vehicleNum,
                    vehicleCd,
                    vehicleCorpCd,
                    running:
                        text.includes("*")
                });
            }
        });

    return buses;
}

/**
 * 車両を重複なしでMapへ追加
 */
function addBusesToMap(
    busMap,
    buses
) {
    for (const bus of buses) {
        const key =
            `${bus.vehicleCorpCd}_${bus.vehicleCd}`;

        const existing =
            busMap.get(key);

        if (existing) {
            existing.running =
                existing.running ||
                bus.running;
        } else {
            busMap.set(
                key,
                bus
            );
        }
    }
}

/**
 * 検索結果を全ページ巡回する
 */
async function collectAllBuses() {
    console.log("");
    console.log(
        "車番「0」で全車両を検索します"
    );

    const firstResponse =
        await postForm(
            SEARCH_URL,
            {
                "form:inputVehicleNum":
                    "0",

                "form:doSearch":
                    "検 索",

                "form:langItems":
                    "0",

                "form/view/searchVehicle.html":
                    "form"
            }
        );

    let currentHtml =
        firstResponse.data;

    let currentUrl =
        firstResponse.request
            ?.res
            ?.responseUrl ||
        SEARCH_URL;

    const busMap =
        new Map();

    let previousFirstKey = "";
    let safetyCount = 0;

    while (true) {
        safetyCount++;

        if (safetyCount > 200) {
            throw new Error(
                "ページ巡回が200回を超えたため停止しました"
            );
        }

        const $ =
            cheerio.load(
                currentHtml
            );

        const currentPage =
            Number(
                $("#pageNo-bottom")
                    .text()
                    .trim()
            ) ||
            Number(
                $("#pageNo-top")
                    .text()
                    .trim()
            ) ||
            safetyCount;

        const totalPages =
            Number(
                $("#totalPageNo-bottom")
                    .text()
                    .trim()
            ) ||
            Number(
                $("#totalPageNo-top")
                    .text()
                    .trim()
            ) ||
            1;

        const pageBuses =
            extractBuses($);

        if (
            pageBuses.length === 0
        ) {
            throw new Error(
                `${currentPage}ページ目で車両を取得できませんでした`
            );
        }

        const firstBus =
            pageBuses[0];

        const firstKey =
            `${firstBus.vehicleCorpCd}_${firstBus.vehicleCd}`;

        if (
            currentPage > 1 &&
            firstKey ===
                previousFirstKey
        ) {
            throw new Error(
                `${currentPage}ページ目への移動に失敗しました。` +
                "同じ検索結果が返されています"
            );
        }

        previousFirstKey =
            firstKey;

        addBusesToMap(
            busMap,
            pageBuses
        );

        console.log(
            `検索結果 ${currentPage}/${totalPages}ページ` +
            `：このページ${pageBuses.length}台、` +
            `累計${busMap.size}台`
        );

        fs.writeFileSync(
            "buses.json",
            JSON.stringify(
                [...busMap.values()],
                null,
                2
            ),
            "utf8"
        );

        const hasNext =
            $("#doNextBottom").length > 0 ||
            $("#doNextTop").length > 0;

        if (
            !hasNext ||
            currentPage >= totalPages
        ) {
            break;
        }

        const actionUrl =
            getFormAction(
                $,
                currentUrl
            );

        const nextParams =
            createNextPageParams(
                $,
                currentHtml
            );

        console.log(
            `次ページ送信：pageNo=${
                nextParams[
                    "form:pageNo"
                ]
            }`
        );

        const nextResponse =
            await postForm(
                actionUrl,
                nextParams,
                currentUrl
            );

        currentHtml =
            nextResponse.data;

        currentUrl =
            nextResponse.request
                ?.res
                ?.responseUrl ||
            actionUrl;

        await sleep(
            PAGE_WAIT_MS
        );
    }

    return [
        ...busMap.values()
    ];
}

/**
 * 1台分のGPSを取得する
 */
async function getBusGps(bus) {
    const vehicleStateUrl =
        `${VIEW_BASE_URL}vehicleState.html` +
        `?vehicleCorpCd=${bus.vehicleCorpCd}` +
        `&vehicleCd=${bus.vehicleCd}` +
        `&lang=0`;

    const stateResponse =
        await getHtml(
            vehicleStateUrl,
            SEARCH_URL
        );

    if (
        stateResponse.data.includes(
            "該当する車両の運行情報がありません"
        )
    ) {
        console.log(
            `${bus.vehicleNum} 運行情報消滅`
        );

        return null;
    }

    const state$ =
        cheerio.load(
            stateResponse.data
        );

    const mapHref =
        state$(
            "a#mapApproachVehicle"
        ).attr("href");

    if (!mapHref) {
        return null;
    }

    const stateResponseUrl =
        stateResponse.request
            ?.res
            ?.responseUrl ||
        vehicleStateUrl;

    const mapUrl =
        new URL(
            mapHref,
            stateResponseUrl
        ).href;

    const mapResponse =
        await getHtml(
            mapUrl,
            stateResponseUrl
        );

    const map$ =
        cheerio.load(
            mapResponse.data
        );

    const latitude =
        map$("#busLatitude").val();

    const longitude =
        map$("#busLongitude").val();

    if (
        !latitude ||
        !longitude
    ) {
        return null;
    }

    return {
        vehicleNum:
            bus.vehicleNum,

        vehicleCd:
            bus.vehicleCd,

        vehicleCorpCd:
            bus.vehicleCorpCd,

        running:
            bus.running,

        lat:
            Number(latitude),

        lon:
            Number(longitude),

        route:
            map$("#routeNm")
                .text()
                .trim(),

        stop:
            map$("#vehicleStopName")
                .val() || "",

        passTime:
            map$("#vehiclePassTime")
                .val() || "",

        vehicleType:
            map$("#vehicleTypeName")
                .val() || "",

        updateTime:
            map$("#updateTime")
                .text()
                .trim()
    };
}

/**
 * 配列を指定した同時実行数で処理する
 */
async function mapWithConcurrency(
    items,
    limit,
    handler
) {
    let nextIndex = 0;

    async function worker() {
        while (true) {
            const index =
                nextIndex++;

            if (
                index >=
                items.length
            ) {
                return;
            }

            await handler(
                items[index],
                index
            );
        }
    }

    const workerCount =
        Math.min(
            limit,
            items.length
        );

    await Promise.all(
        Array.from(
            {
                length:
                    workerCount
            },
            () => worker()
        )
    );
}

/**
 * GPS取得結果をファイルへ保存する
 */
function saveGpsResults(
    results,
    noMapBuses,
    errorBuses
) {
    fs.writeFileSync(
        "bus-gps.json",
        JSON.stringify(
            results,
            null,
            2
        ),
        "utf8"
    );

    fs.writeFileSync(
        "bus-no-gps.json",
        JSON.stringify(
            noMapBuses,
            null,
            2
        ),
        "utf8"
    );

    fs.writeFileSync(
        "bus-errors.json",
        JSON.stringify(
            errorBuses,
            null,
            2
        ),
        "utf8"
    );
}

/**
 * メイン処理
 */
async function main() {
    console.log(
        "=============================="
    );

    console.log(
        "南海バス 全車両GPS取得を開始"
    );

    console.log(
        "=============================="
    );

    try {
        const buses =
            await collectAllBuses();

        console.log("");
        console.log(
            "=============================="
        );

        console.log(
            `全ページ巡回完了：${buses.length}台`
        );

        console.log(
            "=============================="
        );

        fs.writeFileSync(
            "buses.json",
            JSON.stringify(
                buses,
                null,
                2
            ),
            "utf8"
        );

        const runningBuses =
            buses.filter(
                bus =>
                    bus.running
            );

        console.log(
            `運行中車両：${runningBuses.length}台`
        );

        const results = [];
        const noMapBuses = [];
        const errorBuses = [];

        let completedCount = 0;

        await mapWithConcurrency(
            runningBuses,
            VEHICLE_CONCURRENCY,

            async (
                bus,
                index
            ) => {
                console.log(
                    `[${index + 1}/${runningBuses.length}] ` +
                    `${bus.vehicleNum} を取得中...`
                );

                try {
                    const result =
                        await getBusGps(
                            bus
                        );

                    if (!result) {
                        console.log(
                            `${bus.vehicleNum} 地図・GPSなし`
                        );

                        noMapBuses.push(
                            bus
                        );
                    } else {
                        results.push(
                            result
                        );

                        console.log(
                            `${bus.vehicleNum} OK`,
                            result.lat,
                            result.lon,
                            result.stop
                        );
                    }
                } catch (error) {
                    console.error(
                        `${bus.vehicleNum} NG:`,
                        error.message
                    );

                    errorBuses.push({
                        ...bus,
                        error:
                            error.message
                    });
                }

                completedCount++;

                if (
                    completedCount %
                        SAVE_EVERY ===
                        0 ||
                    completedCount ===
                        runningBuses.length
                ) {
                    saveGpsResults(
                        results,
                        noMapBuses,
                        errorBuses
                    );

                    console.log(
                        `途中保存：${completedCount}/` +
                        `${runningBuses.length}台処理済み`
                    );
                }
            }
        );

        saveGpsResults(
            results,
            noMapBuses,
            errorBuses
        );

        console.log("");
        console.log(
            "=============================="
        );

        console.log(
            "全処理完了"
        );

        console.log(
            `全車両：${buses.length}台`
        );

        console.log(
            `運行中：${runningBuses.length}台`
        );

        console.log(
            `GPS取得成功：${results.length}台`
        );

        console.log(
            `GPSなし：${noMapBuses.length}台`
        );

        console.log(
            `エラー：${errorBuses.length}台`
        );

        console.log(
            "=============================="
        );

        console.log(
            "buses.json"
        );

        console.log(
            "bus-gps.json"
        );

        console.log(
            "bus-no-gps.json"
        );

        console.log(
            "bus-errors.json"
        );

        console.log(
            "へ保存しました"
        );
    } catch (error) {
        console.error("");
        console.error(
            "全体処理失敗:",
            error.message
        );

        if (error.response) {
            console.error(
                "HTTPステータス:",
                error.response.status
            );

            console.error(
                String(
                    error.response.data
                ).slice(
                    0,
                    1000
                )
            );
        }
    }
}

function sleep(ms) {
    return new Promise(
        resolve =>
            setTimeout(
                resolve,
                ms
            )
    );
}

main();