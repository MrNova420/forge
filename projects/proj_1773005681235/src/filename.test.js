const { test } = require('node:test');
const assert = require('assert');

describe('navigateElement', () => {
  it('should navigate to an element and adjust font size based on screen reader compatibility', async () => {
    // Mock the document.querySelector method to return a valid element
    const mockDocument = {
      querySelector: jest.fn().mockResolvedValueOnce({ dataset: { id: 'element1' } })
    };

    global.document = mockDocument;

    try {
      await navigateElement({ query: { elementId: 'element1' } }, { json: jest.fn() });
      
      // Check if the document body class list was updated
      assert.strictEqual(document.body.classList.contains('element1'), true);
      
      // Check if the response size is 150% for screen reader compatibility
      const jsonResponse = JSON.parse(global.document.json.mock.calls[0][0]);
      assert.strictEqual(jsonResponse.size, '150%');
    } finally {
      global.document = undefined;
    }
  });

  it('should throw an error if the element ID is invalid', async () => {
    try {
      await navigateElement({ query: { elementId: null } }, { json: jest.fn() });
      assert.fail('Expected an error to be thrown');
    } catch (err) {
      assert.strictEqual(err.message, 'Invalid element ID');
    }
  });

  it('should handle edge cases where the element is not found', async () => {
    // Mock the document.querySelector method to return null
    const mockDocument = {
      querySelector: jest.fn().mockResolvedValueOnce(null)
    };

    global.document = mockDocument;

    try {
      await navigateElement({ query: { elementId: 'element1' } }, { json: jest.fn() });
      
      // Check if the document body class list was not updated
      assert.strictEqual(document.body.classList.contains('element1'), false);
      
      // Check if the response size is 100% for non-screen reader compatibility
      const jsonResponse = JSON.parse(global.document.json.mock.calls[0][0]);
      assert.strictEqual(jsonResponse.size, '100%');
    } finally {
      global.document = undefined;
    }
  });
});
### Explanation:
- **Happy Path**: Tests that the function navigates to an element and adjusts the font size based on screen reader compatibility.
- **Edge Cases**:
  - Null or undefined element ID throws an error.
  - Element not found does not update the class list and returns a default font size.
- **Error Case**: Tests that an error is thrown for invalid input.