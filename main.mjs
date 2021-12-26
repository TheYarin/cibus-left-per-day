import fetch from "node-fetch";
import moment from "moment";
import { JSDOM } from "jsdom";
import yargs from "yargs";

function setTerminalTitle(title) {
  process.title = title;
  process.stdout.write(`${String.fromCharCode(27)}]0;${title}${String.fromCharCode(7)}`);
}

async function sleep(ms) {
  const stupidSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const startTime = Date.now();
  const samplingInterval = 1000;

  while (Date.now() - startTime < ms) await stupidSleep(samplingInterval);

  // TODO snooze for a little longer after waking from a long sleep
}

async function getCibusLoginCookies(username, company, password) {
  const loginResponse = await fetch("https://www.mysodexo.co.il/?mob=1", {
    headers: {
      accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
      "accept-language": "en-US,en;q=0.9",
      "cache-control": "max-age=0",
      "content-type": "application/x-www-form-urlencoded",
      "sec-ch-ua": '"Chromium";v="92", " Not A;Brand";v="99", "Google Chrome";v="92"',
      "sec-ch-ua-mobile": "?0",
      "sec-fetch-dest": "iframe",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "same-origin",
      "sec-fetch-user": "?1",
      "upgrade-insecure-requests": "1",
    },
    referrer: "https://www.mysodexo.co.il/?mob=1",
    referrerPolicy: "strict-origin-when-cross-origin",
    body: `__EVENTTARGET=&__EVENTARGUMENT=&__VIEWSTATE=&__VIEWSTATEGENERATOR=&txtUsr=${username}%7C${company}&txtPas=${password}&txtCmp=${company}&ctl12=&ctl19=`,
    method: "POST",
    mode: "cors",
  });

  function parseCookies(response) {
    // Shamelessly copied from https://stackoverflow.com/a/55680330/7009364
    const raw = response.headers.raw()["set-cookie"];
    return raw
      .map((entry) => {
        const parts = entry.split(";");
        const cookiePart = parts[0];
        return cookiePart;
      })
      .join(";");
  }

  const cookiesFromLogin = parseCookies(loginResponse);

  return cookiesFromLogin;
}

async function getAmountLeftInCibus(cibusLoginCookies) {
  const fetchBalanceLeftInCibusResponse = await fetch("https://www.mysodexo.co.il/new_ajax_service.aspx?getBdgt=1", {
    headers: {
      accept: "*/*",
      "accept-language": "en-US,en;q=0.9",
      "sec-ch-ua": '"Chromium";v="92", " Not A;Brand";v="99", "Google Chrome";v="92"',
      "sec-ch-ua-mobile": "?0",
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      "x-requested-with": "XMLHttpRequest",
      cookie: cibusLoginCookies,
    },
    referrer: "https://www.mysodexo.co.il/new_my/new_my_budget.aspx",
    referrerPolicy: "strict-origin-when-cross-origin",
    body: null,
    method: "GET",
    mode: "cors",
  });

  const body = await fetchBalanceLeftInCibusResponse.text();
  const budgetLeft = Number.parseFloat(body);

  return budgetLeft;
}

async function getNumberOfWorkDaysLeft(cibusLoginCookies) {
  const today = moment();
  const tomorrow = today.clone().add(1, "days");

  async function wasCibusAlreadyUsedToday(cibusLoginCookies) {
    const transactionsTablePageResponse = await fetch("https://www.mysodexo.co.il/new_my/new_my_orders.aspx", {
      headers: {
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
        "accept-language": "en-US,en;q=0.9",
        "cache-control": "max-age=0",
        "sec-ch-ua": '"Chromium";v="92", " Not A;Brand";v="99", "Google Chrome";v="92"',
        "sec-ch-ua-mobile": "?0",
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "same-origin",
        "sec-fetch-user": "?1",
        "upgrade-insecure-requests": "1",
        cookie: cibusLoginCookies,
      },
      referrerPolicy: "strict-origin-when-cross-origin",
      body: null,
      method: "GET",
      mode: "cors",
    });

    const html = await transactionsTablePageResponse.text();

    const { document } = new JSDOM(html).window;
    const lastTransactionDateString = document.querySelector(
      "#ctl00_ctl01 > div > div.new-content-wrap > table > tbody > tr:nth-child(2) > td:nth-child(2)"
    )?.innerHTML;

    if (lastTransactionDateString === undefined) return false; // This happens when there are no transactions in the table, which happens at the beginning of the month, for example.

    const lastTransactionDate = moment(lastTransactionDateString, "DD/MM/YY");
    const today = moment();

    return today.isSame(lastTransactionDate, "days");
  }

  const shouldStartCountingFromTomorrow = await wasCibusAlreadyUsedToday(cibusLoginCookies);
  const startDate = shouldStartCountingFromTomorrow ? tomorrow : today;

  /**
   *
   * @param month 1-12
   * @param year
   * @returns
   */
  async function getHolidaysOfMonth(month, year) {
    const hebrewsToExclude = ["חנוכה", "חול המועד", "חוה״מ", "שמחת תורה", "סוכות ב׳", "סוכות יום ב", "יום העלייה"];

    const response = await fetch(
      `https://www.hebcal.com/hebcal?v=1&cfg=json&maj=on&min=off&mod=on&nx=off&year=${year}&month=${month}&ss=off&mf=off&c=off&geo=none&s=off`
    );
    const payload = await response.json();
    const holidays = payload.items
      .filter(({ hebrew }) => !hebrewsToExclude.some((holidayThatDoesntCount) => hebrew.includes(holidayThatDoesntCount)))
      .map((item) => ({ name: item.title, date: moment(item.date) }));

    return holidays;
  }

  const holidays = await getHolidaysOfMonth(today.month() + 1, today.year());

  let workDaysLeft = 0;

  for (const date = startDate.clone(); date.month() === today.month(); date.add(1, "days")) {
    if (["Friday", "Saturday"].includes(date.format("dddd"))) continue;
    if (holidays.some((holiday) => date.isSame(holiday.date, "days"))) continue;

    workDaysLeft++;
  }

  return workDaysLeft;
}

function numberToMoneyString(amountOfMoney) {
  return new Intl.NumberFormat("he-IL", { style: "currency", currency: "ILS" }).format(amountOfMoney);
}

setTerminalTitle("Cibus-per-day");

const {
  username,
  company,
  password,
  watch: shouldWatch,
} = yargs(process.argv.slice(2))
  .command("$0 <username> <company> <password>")
  .option("watch", {
    alias: ["w", "widget"],
    type: "boolean",
    description:
      "Run this every few minutes. This option is useful if you want to leave the terminal window open and have it auto-refresh.",
  })
  .positional("username", { type: "string" })
  .positional("company", { type: "string" })
  .positional("password", { type: "string" })
  .strict().argv;

while (true) {
  try {
    const cibusLoginCookies = await getCibusLoginCookies(username, company, password);
    const timeOfCheck = moment();
    const totalAmountLeftInCibus = await getAmountLeftInCibus(cibusLoginCookies);
    const numberOfWorkDaysLeft = await getNumberOfWorkDaysLeft(cibusLoginCookies);

    console.clear();

    if (numberOfWorkDaysLeft === 0) {
      console.log(
        `The month has ended! you have ${totalAmountLeftInCibus ? numberToMoneyString(totalAmountLeftInCibus) : "no money"} left.`
      );
    } else {
      const amountLeftPerDay = totalAmountLeftInCibus / numberOfWorkDaysLeft;
      const formattedAmountLeftPerDay = numberToMoneyString(amountLeftPerDay);
      console.log(`Amount left in Cibus per working day until the end of the month: \n\n${formattedAmountLeftPerDay}`);
      console.log(`\nTotal left: ${numberToMoneyString(totalAmountLeftInCibus)}`);
      console.log(`Work days left: ${numberOfWorkDaysLeft}`);
    }

    if (!shouldWatch) process.exit(0);

    console.log(`\n\nTime of last check: ${timeOfCheck.format("HH:mm")}`);
  } catch (error) {
    if (error.code !== "ENOTFOUND" && error.code !== "ETIMEDOUT") throw error;
  }

  let minutesBetweenChecks;
  const currentHour = moment().hour();

  if (currentHour <= 10) minutesBetweenChecks = 60;
  else if (11 <= currentHour && currentHour <= 14) minutesBetweenChecks = 15;
  else if (15 <= currentHour) minutesBetweenChecks = 60;

  // minutesBetweenChecks = 5; // DEBUG
  // await sleep(1000); // DEBUG

  // console.log(`before sleep: ${moment().format()}`) // DEBUG
  await sleep(1000 * 60 * minutesBetweenChecks);
  // console.log(`after sleep: ${moment().format()}`) // DEBUG
}

/*
TODO:
- handle wrong password
- wrap nicely for npx
- figure out why the number is wrong sometimes
*/
