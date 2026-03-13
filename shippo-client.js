/**
 * Shippo API Client
 *
 * Handles authentication and all Shippo REST API calls.
 *
 * Auth priority:
 *   1. SHIPPO_API_KEY  — direct API key (ShippoToken prefix)
 *   2. SHIPPO_CLIENT_ID + SHIPPO_CLIENT_SECRET — OAuth client credentials
 *
 * Shippo base: https://api.goshippo.com
 */

import { logger } from './logger.js';

const SHIPPO_BASE = 'https://api.goshippo.com';
const OAUTH_TOKEN_URL = 'https://api.goshippo.com/oauth/access_tokens';

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------

let _oauthToken = null;
let _oauthExpiry = 0;

async function getAuthHeader() {
  const apiKey = process.env.SHIPPO_API_KEY;
  if (apiKey) {
    return `ShippoToken ${apiKey}`;
  }

  const clientId = process.env.SHIPPO_CLIENT_ID;
  const clientSecret = process.env.SHIPPO_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('No Shippo credentials. Set SHIPPO_API_KEY or SHIPPO_CLIENT_ID + SHIPPO_CLIENT_SECRET.');
  }

  // Refresh OAuth token if expired (5-minute buffer)
  if (!_oauthToken || Date.now() >= _oauthExpiry - 5 * 60 * 1000) {
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Shippo OAuth failed: ${res.status} ${text}`);
    }
    const data = await res.json();
    _oauthToken = data.access_token;
    _oauthExpiry = Date.now() + (data.expires_in ?? 3600) * 1000;
    logger.info('Shippo OAuth token refreshed', { expiresIn: data.expires_in });
  }

  return `Bearer ${_oauthToken}`;
}

// ---------------------------------------------------------------------------
// Core request helper
// ---------------------------------------------------------------------------

async function shippoRequest(method, path, body = null) {
  const authHeader = await getAuthHeader();
  const options = {
    method,
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/json',
    },
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(`${SHIPPO_BASE}${path}`, options);

  if (!res.ok) {
    const text = await res.text();
    let detail = text;
    try { detail = JSON.parse(text); } catch {}
    logger.error('Shippo API error', { method, path, status: res.status, detail });
    throw Object.assign(new Error(`Shippo API error ${res.status}`), { status: res.status, detail });
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// Address
// ---------------------------------------------------------------------------

/**
 * Create and optionally validate an address.
 * Pass validate: true to trigger Shippo address validation.
 */
export async function createAddress(addressData, validate = false) {
  const body = { ...addressData, validate };
  return shippoRequest('POST', '/addresses/', body);
}

/**
 * Validate an existing address object (by address ID).
 */
export async function validateAddress(addressId) {
  return shippoRequest('GET', `/addresses/${addressId}/validate/`);
}

// ---------------------------------------------------------------------------
// Shipments + Rates
// ---------------------------------------------------------------------------

/**
 * Create a shipment and retrieve available rates.
 *
 * @param {object} addressFrom  - Shippo address object or ID
 * @param {object} addressTo    - Shippo address object or ID
 * @param {object|object[]} parcels - Parcel object(s) or ID(s)
 * @param {object} [options]    - Additional shipment fields (extra, carrier_accounts, etc.)
 */
export async function createShipment(addressFrom, addressTo, parcels, options = {}) {
  const body = {
    address_from: addressFrom,
    address_to: addressTo,
    parcels: Array.isArray(parcels) ? parcels : [parcels],
    async: false,  // synchronous — rates are available immediately
    ...options,
  };
  return shippoRequest('POST', '/shipments/', body);
}

/**
 * Get shipment details by ID.
 */
export async function getShipment(shipmentId) {
  return shippoRequest('GET', `/shipments/${shipmentId}/`);
}

/**
 * List recent shipments.
 */
export async function listShipments(limit = 20) {
  return shippoRequest('GET', `/shipments/?results=${limit}`);
}

// ---------------------------------------------------------------------------
// Transactions (Labels)
// ---------------------------------------------------------------------------

/**
 * Purchase a shipping label for a given rate ID.
 *
 * @param {string} rateId     - Rate object ID from createShipment
 * @param {string} [labelFormat] - 'PDF' (default), 'PNG', 'ZPLII'
 */
export async function purchaseLabel(rateId, labelFormat = 'PDF') {
  const body = {
    rate: rateId,
    label_file_type: labelFormat,
    async: false,
  };
  return shippoRequest('POST', '/transactions/', body);
}

/**
 * Get transaction (label) details by ID.
 */
export async function getTransaction(transactionId) {
  return shippoRequest('GET', `/transactions/${transactionId}/`);
}

/**
 * List recent transactions (labels).
 */
export async function listTransactions(limit = 20) {
  return shippoRequest('GET', `/transactions/?results=${limit}`);
}

// ---------------------------------------------------------------------------
// Tracking
// ---------------------------------------------------------------------------

/**
 * Track a shipment.
 *
 * @param {string} carrier        - Carrier token (e.g. 'usps', 'fedex', 'ups')
 * @param {string} trackingNumber - Tracking number
 */
export async function trackShipment(carrier, trackingNumber) {
  return shippoRequest('GET', `/tracks/${carrier}/${trackingNumber}/`);
}

// ---------------------------------------------------------------------------
// Carrier Accounts
// ---------------------------------------------------------------------------

/**
 * List all carrier accounts connected to the Shippo account.
 */
export async function listCarrierAccounts() {
  return shippoRequest('GET', '/carrier_accounts/');
}

// ---------------------------------------------------------------------------
// Parcels
// ---------------------------------------------------------------------------

/**
 * Create a parcel (saved for reuse).
 */
export async function createParcel(length, width, height, distanceUnit, weight, massUnit) {
  return shippoRequest('POST', '/parcels/', {
    length: String(length),
    width: String(width),
    height: String(height),
    distance_unit: distanceUnit,
    weight: String(weight),
    mass_unit: massUnit,
  });
}
