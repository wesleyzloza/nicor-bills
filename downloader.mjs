// @ts-check
import chalk from 'chalk';
import { eachMonthOfInterval, format } from 'date-fns';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { AuthenticationError } from './auth-error.mjs';
import { PollingOptions } from './downloader-options.mjs';

/**
 * Nicor Gas Bill Download Utility
 * @description A utility for bulk downloading utility bills from Nicor Gas
 * company. Unlike the web portal, this utility can collect bills beyond
 * two year range and utilizes polling to estimate issue dates.
 */
export class NicorGasBillDownloader {
  /**
   * Constructs a new instance of a Nicor Gas bill downloader.
   * @param {string} accountNumber Account number.
   * @param {string} billingId Billing identification number.
   */
  constructor(accountNumber, billingId) {
    this.accountNumber = accountNumber;
    this.billId = billingId;
  }

  /**
   * Southern gas company customer portal base URL.
   * @type {string}
   * @private
   */
  _baseURL = 'https://customerportal.southerncompany.com';

  /**
   * Session cookies.
   * @type {import('puppeteer').Cookie[]}
   * @private
   */
  _sessionCookies = [];

  /**
   * Tries to perform a bulk download of bills within a provided date range.
   * @param {Date} from Start date.
   * @param {Date} to End date.
   * @param {string} saveDirectory Save directory.
   * @param {PollingOptions | undefined} pollingOptions Polling options.
   */
  async tryBulkDownload(from, to, saveDirectory, pollingOptions = undefined) {
    const months = eachMonthOfInterval({ start: from, end: to });
    for (let i = 0; i < months.length; i++) {
      try {
        await this.tryDownloadingBill(months[i], saveDirectory, pollingOptions);
      } catch {}
    }
  }

  /**
   * Tries to download a bill for a specific month.
   * @param {Date} issuedDate A date whose month and year indicate when the bill was issued.
   * @param {PollingOptions | undefined} pollingOptions Polling options.
   */
  async tryDownloadingBill(issuedDate, saveDirectory, pollingOptions = undefined) {
    const issuedYear = issuedDate.getFullYear();
    const issuedMonth = issuedDate.getMonth();
    const issuedDateFormated = format(issuedDate, 'MM/yyyy');
    console.log(chalk.blue(`Trying to download bill issued in the month of ${issuedDateFormated}`));

    const options = Object.assign(new PollingOptions(), pollingOptions);
    const startTryingOn = Math.min(31, Math.max(0, options.startTryingOn));
    const stopTryingOn = Math.min(31, Math.max(0, options.stopTryingOn));

    for (let day = startTryingOn; day <= stopTryingOn; day++) {
      const estimatedBillDate = new Date(issuedYear, issuedMonth, day);
      console.log(`- Trying ${format(estimatedBillDate, 'MM/dd/yyyy')}`);

      try {
        const stream = await this.requestBill(estimatedBillDate);
        console.log(chalk.blue('Bill found! Saving PDF to disk.'));

        const fileName = format(new Date(estimatedBillDate), 'yyyy-MM-dd');
        const savePath = path.resolve(saveDirectory, `${this.accountNumber}-${fileName}.pdf`);
        await fs.writeFile(savePath, stream);

        console.log(chalk.green('Success!\n'));
        return;
      } catch (error) {
        if (error instanceof AuthenticationError) {
          console.log(chalk.red(error.message));
          return;
        }
      }
    }

    console.log(chalk.red('Operation failed.\n'));
    throw new Error(`Unable to find and/or download a bill for the month of ${issuedDateFormated}`);
  }

  /**
   * Requests a Nicor Gas bill issued on the provided date. This method will fail
   * to resolve if a bill is not found for the given issue date.
   * @param {Date} billDate Bill issued date.
   * @returns {Promise<ReadableStream<Uint8Array>>}
   */
  async requestBill(billDate) {
    const billDateString = format(billDate, 'MM/dd/yyyy');
    const requestUrl = `${this._baseURL}/Billing/ViewBill?BillDate=${billDateString}&BillId=${this.billId}&BillRoutingNum=1`;

    try {
      const response = await fetch(requestUrl, {
        headers: {
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
          'accept-language': 'en-US,en;q=0.9',
          'cache-control': 'max-age=0',
          priority: 'u=0, i',
          'sec-ch-ua': '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"',
          'sec-fetch-dest': 'document',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-site': 'none',
          'sec-fetch-user': '?1',
          'upgrade-insecure-requests': '1',
          cookie: this._sessionCookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '),
        },
        referrerPolicy: 'strict-origin-when-cross-origin',
        body: null,
        method: 'GET',
      });

      if (response.redirected === true && response.url.includes('Generic')) {
        throw new AuthenticationError('Unable to make the bill request. An authentication issue has likely occured.');
      } else if (response.headers.get('Content-Type') === 'application/pdf' && response.body !== null) {
        return response.body;
      } else {
        return Promise.reject();
      }
    } catch (error) {
      if (error instanceof AuthenticationError) {
        throw error;
      } else {
        throw new Error('An unknown error occurred.');
      }
    }
  }

  /**
   * Authenticates against the backend server using a headless browser.
   * @param {string} username Username
   * @param {string} password Password
   */
  async authenticate(username, password) {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    await page.goto(`${this._baseURL}/User/Login?LDC=7`);
    await page.locator('#username').fill(username);
    await page.locator('#inputPassword').fill(password);

    await Promise.all([
      page.locator('#loginbtn').click(),
      page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 100000 }),
    ]);

    await Promise.all([
      page.locator(`a ::-p-text(${this.accountNumber})`).click(),
      page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 100000 }),
    ]);

    await page.goto(`${this._baseURL}/Billing/PaymentHistory`);
    this._sessionCookies = await page.cookies();
    browser.close();
  }
}