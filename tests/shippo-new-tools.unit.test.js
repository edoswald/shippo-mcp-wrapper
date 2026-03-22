import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as shippoClient from '../shippo-client.js';

vi.mock('../shippo-client.js');

// Mirrors the ok() helper in index.js
function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

// Mirrors safeToolHandler in index.js
function safeToolHandler(handler) {
  return async (params) => {
    try {
      return await handler(params);
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: false, exit_reason: 'tool_error', message: err.message }) }],
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Handler factories — replicate the exact logic from index.js
// ---------------------------------------------------------------------------

function makeListOrdersHandler() {
  return safeToolHandler(async ({ page, results, order_status }) => {
    try {
      const data = await shippoClient.listOrdersPaginated({ page, results, order_status });
      return ok(data);
    } catch (err) {
      return ok({ error: err.message, exit_reason: 'shippo_api_error' });
    }
  });
}

function makeGetOrderHandler() {
  return safeToolHandler(async ({ order_id }) => {
    try {
      const o = await shippoClient.getOrder(order_id);
      return ok(o);
    } catch (err) {
      if (err.status === 404) {
        return ok({ error: 'Order not found', exit_reason: 'not_found' });
      }
      return ok({ error: err.message, exit_reason: 'shippo_api_error' });
    }
  });
}

function makeCreateAddressHandler() {
  return safeToolHandler(async ({ name, street1, city, state, zip, country, phone, email, validate }) => {
    if (process.env.TEST_MODE === 'true') {
      return ok({ object_id: 'test_address_id', test_mode: true, message: 'TEST MODE: would have created address' });
    }
    try {
      const result = await shippoClient.createAddress({ name, street1, city, state, zip, country, phone, email }, validate);
      return ok(result);
    } catch (err) {
      return ok({ error: err.message, exit_reason: 'shippo_api_error' });
    }
  });
}

function makeGetAddressHandler() {
  return safeToolHandler(async ({ address_id }) => {
    try {
      const a = await shippoClient.getAddress(address_id);
      return ok(a);
    } catch (err) {
      if (err.status === 404) {
        return ok({ error: 'Address not found', exit_reason: 'not_found' });
      }
      return ok({ error: err.message, exit_reason: 'shippo_api_error' });
    }
  });
}

function makeListAddressesHandler() {
  return safeToolHandler(async ({ page, results }) => {
    try {
      const data = await shippoClient.listAddressesPaginated({ page, results });
      return ok(data);
    } catch (err) {
      return ok({ error: err.message, exit_reason: 'shippo_api_error' });
    }
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe('list_shippo_orders', () => {
  it('returns paginated response from listOrdersPaginated', async () => {
    const mockData = { count: 1, next: null, previous: null, results: [{ object_id: 'ord_1' }] };
    shippoClient.listOrdersPaginated.mockResolvedValue(mockData);

    const handler = makeListOrdersHandler();
    const result = await handler({ results: 25 });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed).toEqual(mockData);
    expect(shippoClient.listOrdersPaginated).toHaveBeenCalledWith({ page: undefined, results: 25, order_status: undefined });
  });

  it('forwards order_status filter to listOrdersPaginated', async () => {
    const mockData = { count: 1, results: [{ object_id: 'ord_2', order_status: 'PAID' }] };
    shippoClient.listOrdersPaginated.mockResolvedValue(mockData);

    const handler = makeListOrdersHandler();
    const result = await handler({ results: 10, order_status: 'PAID' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed).toEqual(mockData);
    expect(shippoClient.listOrdersPaginated).toHaveBeenCalledWith({ page: undefined, results: 10, order_status: 'PAID' });
  });
});

describe('get_shippo_order', () => {
  it('returns order object on success', async () => {
    const mockOrder = { object_id: 'ord_abc', order_number: '#1001', order_status: 'PAID' };
    shippoClient.getOrder.mockResolvedValue(mockOrder);

    const handler = makeGetOrderHandler();
    const result = await handler({ order_id: 'ord_abc' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed).toEqual(mockOrder);
    expect(shippoClient.getOrder).toHaveBeenCalledWith('ord_abc');
  });

  it('returns exit_reason: "not_found" on 404', async () => {
    const err = Object.assign(new Error('Not found'), { status: 404 });
    shippoClient.getOrder.mockRejectedValue(err);

    const handler = makeGetOrderHandler();
    const result = await handler({ order_id: 'ord_missing' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.exit_reason).toBe('not_found');
    expect(parsed.error).toBe('Order not found');
  });
});

describe('create_shippo_address', () => {
  afterEach(() => {
    delete process.env.TEST_MODE;
  });

  it('TEST_MODE returns canned response without calling createAddress', async () => {
    process.env.TEST_MODE = 'true';

    const handler = makeCreateAddressHandler();
    const result = await handler({ name: 'Jane Doe', street1: '123 Main St', city: 'Springfield', state: 'IL', zip: '62701', country: 'US' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.test_mode).toBe(true);
    expect(parsed.object_id).toBe('test_address_id');
    expect(shippoClient.createAddress).not.toHaveBeenCalled();
  });

  it('forwards validate: true to createAddress', async () => {
    const mockAddress = { object_id: 'addr_xyz', name: 'Jane Doe', validation_results: { is_valid: true } };
    shippoClient.createAddress.mockResolvedValue(mockAddress);

    const handler = makeCreateAddressHandler();
    const result = await handler({ name: 'Jane Doe', street1: '123 Main St', city: 'Springfield', state: 'IL', zip: '62701', country: 'US', validate: true });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed).toEqual(mockAddress);
    expect(shippoClient.createAddress).toHaveBeenCalledWith(
      { name: 'Jane Doe', street1: '123 Main St', city: 'Springfield', state: 'IL', zip: '62701', country: 'US', phone: undefined, email: undefined },
      true
    );
  });
});

describe('get_shippo_address', () => {
  it('returns address object on success', async () => {
    const mockAddress = { object_id: 'addr_123', name: 'John Smith', city: 'Denver', state: 'CO' };
    shippoClient.getAddress.mockResolvedValue(mockAddress);

    const handler = makeGetAddressHandler();
    const result = await handler({ address_id: 'addr_123' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed).toEqual(mockAddress);
    expect(shippoClient.getAddress).toHaveBeenCalledWith('addr_123');
  });

  it('returns exit_reason: "not_found" on 404', async () => {
    const err = Object.assign(new Error('Not found'), { status: 404 });
    shippoClient.getAddress.mockRejectedValue(err);

    const handler = makeGetAddressHandler();
    const result = await handler({ address_id: 'addr_missing' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.exit_reason).toBe('not_found');
    expect(parsed.error).toBe('Address not found');
  });
});

describe('list_shippo_addresses', () => {
  it('returns paginated response from listAddressesPaginated', async () => {
    const mockData = { count: 2, next: null, previous: null, results: [{ object_id: 'addr_1' }, { object_id: 'addr_2' }] };
    shippoClient.listAddressesPaginated.mockResolvedValue(mockData);

    const handler = makeListAddressesHandler();
    const result = await handler({ results: 25 });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed).toEqual(mockData);
    expect(shippoClient.listAddressesPaginated).toHaveBeenCalledWith({ page: undefined, results: 25 });
  });
});
