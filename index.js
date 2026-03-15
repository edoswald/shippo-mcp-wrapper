/**
 * Shippo MCP Wrapper
 *
 * Lightweight MCP server that exposes Shippo shipping tools via a
 * header-authenticated SSE endpoint. Handles Shippo OAuth on the backend so
 * Retell (which only supports header auth) can use Shippo tools directly.
 *
 * Auth: Bearer token via SSE_TOKEN_<NAME> env vars
 * Shippo auth: SHIPPO_API_KEY (primary) or SHIPPO_CLIENT_ID + SHIPPO_CLIENT_SECRET (OAuth)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { logger } from './logger.js';
import { startSseServer } from './sse-server.js';
import {
  createAddress,
  validateAddress,
  createShipment,
  getShipment,
  listShipments,
  purchaseLabel,
  getTransaction,
  listTransactions,
  trackShipment,
  listCarrierAccounts,
  createParcel,
  listOrders,
  getOrder,
} from './shippo-client.js';

// ---------------------------------------------------------------------------
// Safe tool handler — catches unexpected errors
// ---------------------------------------------------------------------------

function safeToolHandler(handler) {
  return async (params) => {
    try {
      return await handler(params);
    } catch (err) {
      logger.error('Tool handler error', { error: err.message, stack: err.stack });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            exit_reason: 'tool_error',
            message: err.message || 'An unexpected error occurred.',
          }),
        }],
      };
    }
  };
}

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

// ---------------------------------------------------------------------------
// MCP Server factory
// ---------------------------------------------------------------------------

function createMcpServer() {
  const server = new McpServer({
    name: 'shippo-mcp-wrapper',
    version: '1.0.0',
  });

  // -------------------------------------------------------------------------
  // validate_address
  // -------------------------------------------------------------------------
  server.tool(
    'validate_address',
    'Create and validate a shipping address with Shippo. Returns validation results, standardized address components, and any validation messages.',
    {
      name: z.string().describe('Full name of the recipient or sender'),
      street1: z.string().describe('Street address line 1'),
      street2: z.string().optional().describe('Street address line 2 (apartment, suite, etc.)'),
      city: z.string().describe('City'),
      state: z.string().describe('State or province code (e.g. PA, CA)'),
      zip: z.string().describe('ZIP or postal code'),
      country: z.string().default('US').describe('ISO 2-letter country code (default: US)'),
      phone: z.string().optional().describe('Phone number'),
      email: z.string().optional().describe('Email address'),
      company: z.string().optional().describe('Company name'),
    },
    safeToolHandler(async ({ name, street1, street2, city, state, zip, country, phone, email, company }) => {
      const addressData = {
        name,
        street1,
        ...(street2 && { street2 }),
        city,
        state,
        zip,
        country: country || 'US',
        ...(phone && { phone }),
        ...(email && { email }),
        ...(company && { company }),
      };
      const result = await createAddress(addressData, true);
      return ok({
        success: true,
        address_id: result.object_id,
        validation_results: result.validation_results,
        is_complete: result.is_complete,
        name: result.name,
        street1: result.street1,
        street2: result.street2,
        city: result.city,
        state: result.state,
        zip: result.zip,
        country: result.country,
      });
    })
  );

  // -------------------------------------------------------------------------
  // get_shipping_rates
  // -------------------------------------------------------------------------
  server.tool(
    'get_shipping_rates',
    'Get available shipping rates for a shipment between two addresses. Returns all available carrier rates with prices, transit times, and service levels.',
    {
      from_name: z.string().describe('Sender full name'),
      from_street1: z.string().describe('Sender street address'),
      from_city: z.string().describe('Sender city'),
      from_state: z.string().describe('Sender state code'),
      from_zip: z.string().describe('Sender ZIP code'),
      from_country: z.string().default('US').describe('Sender country (default: US)'),
      to_name: z.string().describe('Recipient full name'),
      to_street1: z.string().describe('Recipient street address'),
      to_city: z.string().describe('Recipient city'),
      to_state: z.string().describe('Recipient state code'),
      to_zip: z.string().describe('Recipient ZIP code'),
      to_country: z.string().default('US').describe('Recipient country (default: US)'),
      weight: z.number().describe('Package weight'),
      weight_unit: z.enum(['lb', 'oz', 'kg', 'g']).default('lb').describe('Weight unit'),
      length: z.number().describe('Package length'),
      width: z.number().describe('Package width'),
      height: z.number().describe('Package height'),
      dimension_unit: z.enum(['in', 'cm', 'ft', 'mm', 'm', 'yd']).default('in').describe('Dimension unit'),
    },
    safeToolHandler(async (params) => {
      const {
        from_name, from_street1, from_city, from_state, from_zip, from_country,
        to_name, to_street1, to_city, to_state, to_zip, to_country,
        weight, weight_unit, length, width, height, dimension_unit,
      } = params;

      const addressFrom = {
        name: from_name,
        street1: from_street1,
        city: from_city,
        state: from_state,
        zip: from_zip,
        country: from_country || 'US',
      };
      const addressTo = {
        name: to_name,
        street1: to_street1,
        city: to_city,
        state: to_state,
        zip: to_zip,
        country: to_country || 'US',
      };
      const parcel = {
        length: String(length),
        width: String(width),
        height: String(height),
        distance_unit: dimension_unit || 'in',
        weight: String(weight),
        mass_unit: weight_unit || 'lb',
      };

      const shipment = await createShipment(addressFrom, addressTo, parcel);

      const rates = (shipment.rates || []).map(r => ({
        rate_id: r.object_id,
        provider: r.provider,
        servicelevel_name: r.servicelevel?.name,
        servicelevel_token: r.servicelevel?.token,
        amount: r.amount,
        currency: r.currency,
        estimated_days: r.estimated_days,
        duration_terms: r.duration_terms,
        carrier_account: r.carrier_account,
      }));

      return ok({
        success: true,
        shipment_id: shipment.object_id,
        rates,
        rate_count: rates.length,
      });
    })
  );

  // -------------------------------------------------------------------------
  // create_shipment
  // -------------------------------------------------------------------------
  server.tool(
    'create_shipment',
    'Create a Shippo shipment object using existing address IDs and parcel ID. Returns the shipment ID and available rates. Use validate_address first to get address IDs.',
    {
      address_from_id: z.string().describe('Shippo address ID for the sender (from validate_address)'),
      address_to_id: z.string().describe('Shippo address ID for the recipient (from validate_address)'),
      parcel_id: z.string().optional().describe('Shippo parcel ID (optional — use weight/dimensions instead if not set)'),
      weight: z.number().optional().describe('Weight (required if parcel_id not provided)'),
      weight_unit: z.enum(['lb', 'oz', 'kg', 'g']).optional().default('lb'),
      length: z.number().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      dimension_unit: z.enum(['in', 'cm', 'ft', 'mm', 'm', 'yd']).optional().default('in'),
    },
    safeToolHandler(async (params) => {
      const {
        address_from_id, address_to_id, parcel_id,
        weight, weight_unit, length, width, height, dimension_unit,
      } = params;

      let parcel;
      if (parcel_id) {
        parcel = parcel_id;
      } else {
        parcel = {
          length: String(length || 12),
          width: String(width || 9),
          height: String(height || 3),
          distance_unit: dimension_unit || 'in',
          weight: String(weight || 1),
          mass_unit: weight_unit || 'lb',
        };
      }

      const shipment = await createShipment(address_from_id, address_to_id, parcel);

      const rates = (shipment.rates || []).map(r => ({
        rate_id: r.object_id,
        provider: r.provider,
        servicelevel_name: r.servicelevel?.name,
        amount: r.amount,
        currency: r.currency,
        estimated_days: r.estimated_days,
      }));

      return ok({
        success: true,
        shipment_id: shipment.object_id,
        status: shipment.status,
        rates,
        rate_count: rates.length,
      });
    })
  );

  // -------------------------------------------------------------------------
  // purchase_label
  // -------------------------------------------------------------------------
  server.tool(
    'purchase_label',
    'Purchase a shipping label for a specific rate. Returns the label URL, tracking number, and transaction ID. Use get_shipping_rates or create_shipment first to get rate IDs.',
    {
      rate_id: z.string().describe('Rate object ID from get_shipping_rates or create_shipment'),
      label_format: z.enum(['PDF', 'PNG', 'ZPLII']).default('PDF').describe('Label file format (default: PDF)'),
    },
    safeToolHandler(async ({ rate_id, label_format }) => {
      const transaction = await purchaseLabel(rate_id, label_format || 'PDF');

      if (transaction.status === 'ERROR') {
        return ok({
          success: false,
          exit_reason: 'label_purchase_failed',
          messages: transaction.messages,
        });
      }

      return ok({
        success: true,
        transaction_id: transaction.object_id,
        status: transaction.status,
        tracking_number: transaction.tracking_number,
        tracking_url: transaction.tracking_url_provider,
        label_url: transaction.label_url,
        commercial_invoice_url: transaction.commercial_invoice_url,
        rate: transaction.rate,
        eta: transaction.eta,
      });
    })
  );

  // -------------------------------------------------------------------------
  // get_label
  // -------------------------------------------------------------------------
  server.tool(
    'get_label',
    'Get details of a previously purchased shipping label (transaction). Returns label URL, tracking number, and status.',
    {
      transaction_id: z.string().describe('Transaction/label ID from purchase_label'),
    },
    safeToolHandler(async ({ transaction_id }) => {
      const t = await getTransaction(transaction_id);
      return ok({
        success: true,
        transaction_id: t.object_id,
        status: t.status,
        tracking_number: t.tracking_number,
        tracking_url: t.tracking_url_provider,
        label_url: t.label_url,
        carrier: t.rate?.provider,
        servicelevel: t.rate?.servicelevel?.name,
        eta: t.eta,
      });
    })
  );

  // -------------------------------------------------------------------------
  // list_recent_labels
  // -------------------------------------------------------------------------
  server.tool(
    'list_recent_labels',
    'List recently purchased shipping labels (transactions). Returns tracking numbers, label URLs, carrier info, and status.',
    {
      limit: z.number().int().min(1).max(100).default(20).describe('Number of labels to return (default 20, max 100)'),
    },
    safeToolHandler(async ({ limit }) => {
      const data = await listTransactions(limit || 20);
      const labels = (data.results || []).map(t => ({
        transaction_id: t.object_id,
        status: t.status,
        tracking_number: t.tracking_number,
        tracking_url: t.tracking_url_provider,
        label_url: t.label_url,
        carrier: t.rate?.provider,
        servicelevel: t.rate?.servicelevel?.name,
        created: t.object_created,
      }));
      return ok({ success: true, labels, count: labels.length });
    })
  );

  // -------------------------------------------------------------------------
  // track_shipment
  // -------------------------------------------------------------------------
  server.tool(
    'track_shipment',
    'Track a shipment by tracking number and carrier. Returns current status, location, and full tracking event history.',
    {
      carrier: z.string().describe('Carrier token: usps, fedex, ups, dhl_express, amazon, etc.'),
      tracking_number: z.string().describe('Tracking number'),
    },
    safeToolHandler(async ({ carrier, tracking_number }) => {
      const result = await trackShipment(carrier, tracking_number);
      return ok({
        success: true,
        tracking_number: result.tracking_number,
        carrier: result.carrier,
        status: result.tracking_status?.status,
        status_details: result.tracking_status?.status_details,
        location: result.tracking_status?.location,
        estimated_delivery: result.eta,
        tracking_history: (result.tracking_history || []).map(e => ({
          status: e.status,
          status_details: e.status_details,
          location: e.location,
          date: e.status_date,
        })),
      });
    })
  );

  // -------------------------------------------------------------------------
  // list_carrier_accounts
  // -------------------------------------------------------------------------
  server.tool(
    'list_carrier_accounts',
    'List all carrier accounts connected to the Shippo account (USPS, FedEx, UPS, etc.). Returns carrier names, account numbers, and active status.',
    {},
    safeToolHandler(async () => {
      const data = await listCarrierAccounts();
      const accounts = (data.results || []).map(a => ({
        carrier_account_id: a.object_id,
        carrier: a.carrier,
        account_id: a.account_id,
        active: a.active,
        test: a.test,
        carrier_name: a.carrier_name,
      }));
      return ok({ success: true, carrier_accounts: accounts, count: accounts.length });
    })
  );

  // -------------------------------------------------------------------------
  // list_recent_shipments
  // -------------------------------------------------------------------------
  server.tool(
    'list_recent_shipments',
    'List recent shipments created in Shippo. Returns shipment IDs, addresses, status, and rate counts.',
    {
      limit: z.number().int().min(1).max(100).default(20).describe('Number of shipments to return (default 20, max 100)'),
    },
    safeToolHandler(async ({ limit }) => {
      const data = await listShipments(limit || 20);
      const shipments = (data.results || []).map(s => ({
        shipment_id: s.object_id,
        status: s.status,
        created: s.object_created,
        address_from: {
          name: s.address_from?.name,
          city: s.address_from?.city,
          state: s.address_from?.state,
        },
        address_to: {
          name: s.address_to?.name,
          city: s.address_to?.city,
          state: s.address_to?.state,
        },
        rate_count: s.rates?.length ?? 0,
      }));
      return ok({ success: true, shipments, count: shipments.length });
    })
  );

  // -------------------------------------------------------------------------
  // list_shippo_orders
  // -------------------------------------------------------------------------
  server.tool(
    'list_shippo_orders',
    'List orders synced to Shippo from WooCommerce. Returns order numbers, status, recipient info, and line item counts. WooCommerce orders sync to Shippo automatically.',
    {
      results: z.number().int().min(1).max(100).default(25).describe('Number of orders to return (default 25, max 100)'),
      order_number: z.string().optional().describe('Filter by order number string (partial match supported by Shippo)'),
    },
    safeToolHandler(async ({ results, order_number }) => {
      const data = await listOrders(results ?? 25, order_number ?? null);
      const orders = (data.results || []).map(o => ({
        order_id: o.object_id,
        order_number: o.order_number,
        order_status: o.order_status,
        placed_at: o.placed_at,
        to_name: `${o.to_address?.name ?? ''}`.trim(),
        to_city: o.to_address?.city,
        to_state: o.to_address?.state,
        line_item_count: (o.line_items || []).length,
        total_price: o.total_price,
        currency: o.currency,
        weight: o.weight,
        weight_unit: o.weight_unit,
      }));
      return ok({ success: true, orders, count: orders.length, total: data.count });
    })
  );

  // -------------------------------------------------------------------------
  // get_shippo_order
  // -------------------------------------------------------------------------
  server.tool(
    'get_shippo_order',
    "Get full details of a single Shippo order by Shippo's internal order object ID. Returns recipient address, line items, weight, and linked transactions (labels). Use list_shippo_orders to find the order_id.",
    {
      order_id: z.string().describe("Shippo order object ID (from list_shippo_orders — Shippo's internal ID, not WooCommerce order number)"),
    },
    safeToolHandler(async ({ order_id }) => {
      const o = await getOrder(order_id);
      return ok({
        success: true,
        order_id: o.object_id,
        order_number: o.order_number,
        order_status: o.order_status,
        placed_at: o.placed_at,
        to_address: o.to_address,
        from_address: o.from_address,
        line_items: (o.line_items || []).map(i => ({
          title: i.title,
          sku: i.sku,
          quantity: i.quantity,
          total_price: i.total_price,
          currency: i.currency,
          weight: i.weight,
          weight_unit: i.weight_unit,
        })),
        total_price: o.total_price,
        currency: o.currency,
        weight: o.weight,
        weight_unit: o.weight_unit,
        transactions: o.transactions || [],
        shipping_cost: o.shipping_cost,
        shipping_cost_currency: o.shipping_cost_currency,
        shipping_method: o.shipping_method,
        notes: o.notes,
      });
    })
  );

  return server;
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

// Validate credentials on startup
if (!process.env.SHIPPO_API_KEY && !(process.env.SHIPPO_CLIENT_ID && process.env.SHIPPO_CLIENT_SECRET)) {
  logger.warn('No Shippo credentials found. Set SHIPPO_API_KEY or SHIPPO_CLIENT_ID + SHIPPO_CLIENT_SECRET.');
}

startSseServer(createMcpServer);

logger.info('Shippo MCP wrapper started', {
  tools: [
    'validate_address',
    'get_shipping_rates',
    'create_shipment',
    'purchase_label',
    'get_label',
    'list_recent_labels',
    'track_shipment',
    'list_carrier_accounts',
    'list_recent_shipments',
    'list_shippo_orders',
    'get_shippo_order',
  ],
  shippoAuth: process.env.SHIPPO_API_KEY
    ? 'api_key'
    : (process.env.SHIPPO_CLIENT_ID ? 'oauth_client_credentials' : 'missing'),
});
