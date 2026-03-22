import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import * as shippoClient from '../shippo-client.js';

vi.mock('../shippo-client.js');

// ---------------------------------------------------------------------------
// Mirrors of index.js helpers
// ---------------------------------------------------------------------------

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function safeToolHandler(handler) {
  return async (params) => {
    try {
      return await handler(params);
    } catch (err) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: false, exit_reason: 'tool_error', message: err.message }),
        }],
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Handler factories — exact logic from index.js
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
      if (err.status === 404) return ok({ error: 'Order not found', exit_reason: 'not_found' });
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
      if (err.status === 404) return ok({ error: 'Address not found', exit_reason: 'not_found' });
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
// Arbitraries
// ---------------------------------------------------------------------------

const arbPositiveInt = fc.integer({ min: 1, max: 1000 });

const arbAddressInput = fc.record({
  name: fc.string({ minLength: 1, maxLength: 50 }),
  street1: fc.string({ minLength: 1, maxLength: 100 }),
  city: fc.string({ minLength: 1, maxLength: 50 }),
  state: fc.string({ minLength: 2, maxLength: 10 }),
  zip: fc.string({ minLength: 1, maxLength: 10 }),
  country: fc.string({ minLength: 2, maxLength: 2 }),
});

const arbNonEmptyString = fc.string({ minLength: 1, maxLength: 50 });

// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.TEST_MODE;
});

afterEach(() => {
  delete process.env.TEST_MODE;
});

// ---------------------------------------------------------------------------
// Property 2: create_shippo_address TEST_MODE intercepts write
// Feature: shippo-new-tools, Property 2: For any address input, TEST_MODE always returns test_mode: true and no fetch is called
// ---------------------------------------------------------------------------

describe('Property 2: create_shippo_address TEST_MODE intercepts write', () => {
  it('always returns test_mode: true and never calls createAddress', async () => {
    await fc.assert(
      fc.asyncProperty(arbAddressInput, async (addressInput) => {
        process.env.TEST_MODE = 'true';
        vi.clearAllMocks();

        const handler = makeCreateAddressHandler();
        const result = await handler({ ...addressInput, validate: false });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.test_mode).toBe(true);
        expect(parsed.object_id).toBe('test_address_id');
        expect(shippoClient.createAddress).not.toHaveBeenCalled();
      }),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 3: 404 errors produce not_found exit reason
// Feature: shippo-new-tools, Property 3: For any order_id / address_id, a mocked 404 always produces exit_reason: "not_found"
// ---------------------------------------------------------------------------

describe('Property 3: 404 errors produce not_found exit reason', () => {
  it('get_shippo_order: any id with 404 → exit_reason: not_found', async () => {
    await fc.assert(
      fc.asyncProperty(arbNonEmptyString, async (id) => {
        const err = Object.assign(new Error('Not found'), { status: 404 });
        shippoClient.getOrder.mockRejectedValue(err);

        const handler = makeGetOrderHandler();
        const result = await handler({ order_id: id });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.exit_reason).toBe('not_found');
      }),
      { numRuns: 100 }
    );
  });

  it('get_shippo_address: any id with 404 → exit_reason: not_found', async () => {
    await fc.assert(
      fc.asyncProperty(arbNonEmptyString, async (id) => {
        const err = Object.assign(new Error('Not found'), { status: 404 });
        shippoClient.getAddress.mockRejectedValue(err);

        const handler = makeGetAddressHandler();
        const result = await handler({ address_id: id });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.exit_reason).toBe('not_found');
      }),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4: All tools return MCP content envelope
// Feature: shippo-new-tools, Property 4: For any tool call result, the MCP content envelope shape is always correct
// ---------------------------------------------------------------------------

describe('Property 4: All tools return MCP content envelope', () => {
  it('list_shippo_orders always returns correct envelope', async () => {
    await fc.assert(
      fc.asyncProperty(fc.record({ count: fc.nat(), results: fc.array(fc.record({ object_id: fc.string() })) }), async (mockData) => {
        shippoClient.listOrdersPaginated.mockResolvedValue(mockData);
        const result = await makeListOrdersHandler()({ results: 25 });
        expect(result).toHaveProperty('content');
        expect(Array.isArray(result.content)).toBe(true);
        expect(result.content[0]).toHaveProperty('type', 'text');
        expect(typeof result.content[0].text).toBe('string');
        JSON.parse(result.content[0].text); // must be valid JSON
      }),
      { numRuns: 100 }
    );
  });

  it('get_shippo_order always returns correct envelope', async () => {
    await fc.assert(
      fc.asyncProperty(fc.record({ object_id: fc.string(), order_status: fc.string() }), async (mockOrder) => {
        shippoClient.getOrder.mockResolvedValue(mockOrder);
        const result = await makeGetOrderHandler()({ order_id: 'ord_test' });
        expect(result.content[0].type).toBe('text');
        expect(typeof result.content[0].text).toBe('string');
        JSON.parse(result.content[0].text);
      }),
      { numRuns: 100 }
    );
  });

  it('create_shippo_address always returns correct envelope', async () => {
    await fc.assert(
      fc.asyncProperty(arbAddressInput, async (addressInput) => {
        shippoClient.createAddress.mockResolvedValue({ object_id: 'addr_test' });
        const result = await makeCreateAddressHandler()({ ...addressInput, validate: false });
        expect(result.content[0].type).toBe('text');
        expect(typeof result.content[0].text).toBe('string');
        JSON.parse(result.content[0].text);
      }),
      { numRuns: 100 }
    );
  });

  it('get_shippo_address always returns correct envelope', async () => {
    await fc.assert(
      fc.asyncProperty(fc.record({ object_id: fc.string() }), async (mockAddr) => {
        shippoClient.getAddress.mockResolvedValue(mockAddr);
        const result = await makeGetAddressHandler()({ address_id: 'addr_test' });
        expect(result.content[0].type).toBe('text');
        expect(typeof result.content[0].text).toBe('string');
        JSON.parse(result.content[0].text);
      }),
      { numRuns: 100 }
    );
  });

  it('list_shippo_addresses always returns correct envelope', async () => {
    await fc.assert(
      fc.asyncProperty(fc.record({ count: fc.nat(), results: fc.array(fc.record({ object_id: fc.string() })) }), async (mockData) => {
        shippoClient.listAddressesPaginated.mockResolvedValue(mockData);
        const result = await makeListAddressesHandler()({ results: 25 });
        expect(result.content[0].type).toBe('text');
        expect(typeof result.content[0].text).toBe('string');
        JSON.parse(result.content[0].text);
      }),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 5: Pagination parameters forwarded correctly
// Feature: shippo-new-tools, Property 5: For any page/results combination, query string always contains those exact values
// ---------------------------------------------------------------------------

describe('Property 5: Pagination parameters forwarded correctly', () => {
  it('list_shippo_orders forwards page and results to listOrdersPaginated', async () => {
    await fc.assert(
      fc.asyncProperty(arbPositiveInt, arbPositiveInt, async (page, results) => {
        shippoClient.listOrdersPaginated.mockResolvedValue({ count: 0, results: [] });

        const handler = makeListOrdersHandler();
        await handler({ page, results });

        expect(shippoClient.listOrdersPaginated).toHaveBeenCalledWith(
          expect.objectContaining({ page, results })
        );
      }),
      { numRuns: 100 }
    );
  });

  it('list_shippo_addresses forwards page and results to listAddressesPaginated', async () => {
    await fc.assert(
      fc.asyncProperty(arbPositiveInt, arbPositiveInt, async (page, results) => {
        shippoClient.listAddressesPaginated.mockResolvedValue({ count: 0, results: [] });

        const handler = makeListAddressesHandler();
        await handler({ page, results });

        expect(shippoClient.listAddressesPaginated).toHaveBeenCalledWith(
          expect.objectContaining({ page, results })
        );
      }),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 6: order_status filter forwarded when provided
// Feature: shippo-new-tools, Property 6: For any non-empty order_status string, query string always includes it
// ---------------------------------------------------------------------------

describe('Property 6: order_status filter forwarded when provided', () => {
  it('list_shippo_orders always forwards non-empty order_status', async () => {
    await fc.assert(
      fc.asyncProperty(arbNonEmptyString, async (order_status) => {
        shippoClient.listOrdersPaginated.mockResolvedValue({ count: 0, results: [] });

        const handler = makeListOrdersHandler();
        await handler({ results: 25, order_status });

        expect(shippoClient.listOrdersPaginated).toHaveBeenCalledWith(
          expect.objectContaining({ order_status })
        );
      }),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 7: validate flag forwarded to address creation
// Feature: shippo-new-tools, Property 7: For any validate boolean, POST body always includes the correct validate value
// ---------------------------------------------------------------------------

describe('Property 7: validate flag forwarded to address creation', () => {
  it('create_shippo_address always forwards validate boolean to createAddress', async () => {
    await fc.assert(
      fc.asyncProperty(arbAddressInput, fc.boolean(), async (addressInput, validate) => {
        delete process.env.TEST_MODE;
        shippoClient.createAddress.mockResolvedValue({ object_id: 'addr_test' });

        const handler = makeCreateAddressHandler();
        await handler({ ...addressInput, validate });

        expect(shippoClient.createAddress).toHaveBeenCalledWith(
          expect.objectContaining({ name: addressInput.name }),
          validate
        );
      }),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 8: safeToolHandler catches all unhandled exceptions
// Feature: shippo-new-tools, Property 8: For any thrown exception, safeToolHandler always returns exit_reason: "tool_error"
// ---------------------------------------------------------------------------

describe('Property 8: safeToolHandler catches all unhandled exceptions', () => {
  it('list_shippo_orders: any unexpected throw → exit_reason: tool_error', async () => {
    await fc.assert(
      fc.asyncProperty(arbNonEmptyString, async (message) => {
        shippoClient.listOrdersPaginated.mockImplementation(() => { throw new Error(message); });

        // Use raw safeToolHandler (no inner try/catch) to test safeToolHandler itself
        const handler = safeToolHandler(async ({ page, results, order_status }) => {
          const data = await shippoClient.listOrdersPaginated({ page, results, order_status });
          return ok(data);
        });

        const result = await handler({ results: 25 });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.exit_reason).toBe('tool_error');
      }),
      { numRuns: 100 }
    );
  });

  it('get_shippo_order: unexpected throw (non-404) → exit_reason: tool_error via safeToolHandler', async () => {
    await fc.assert(
      fc.asyncProperty(arbNonEmptyString, async (message) => {
        // Throw without a status property — not a 404, not caught by inner try/catch
        shippoClient.getOrder.mockImplementation(() => { throw new Error(message); });

        const handler = safeToolHandler(async ({ order_id }) => {
          const o = await shippoClient.getOrder(order_id);
          return ok(o);
        });

        const result = await handler({ order_id: 'ord_test' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.exit_reason).toBe('tool_error');
      }),
      { numRuns: 100 }
    );
  });

  it('get_shippo_address: unexpected throw → exit_reason: tool_error via safeToolHandler', async () => {
    await fc.assert(
      fc.asyncProperty(arbNonEmptyString, async (message) => {
        shippoClient.getAddress.mockImplementation(() => { throw new Error(message); });

        const handler = safeToolHandler(async ({ address_id }) => {
          const a = await shippoClient.getAddress(address_id);
          return ok(a);
        });

        const result = await handler({ address_id: 'addr_test' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.exit_reason).toBe('tool_error');
      }),
      { numRuns: 100 }
    );
  });

  it('list_shippo_addresses: unexpected throw → exit_reason: tool_error via safeToolHandler', async () => {
    await fc.assert(
      fc.asyncProperty(arbNonEmptyString, async (message) => {
        shippoClient.listAddressesPaginated.mockImplementation(() => { throw new Error(message); });

        const handler = safeToolHandler(async ({ page, results }) => {
          const data = await shippoClient.listAddressesPaginated({ page, results });
          return ok(data);
        });

        const result = await handler({ results: 25 });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.exit_reason).toBe('tool_error');
      }),
      { numRuns: 100 }
    );
  });
});
