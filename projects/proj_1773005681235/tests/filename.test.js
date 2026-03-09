const { readFileAsync, readNearReadAsync, navigateElement, writeFile } = require('../src/filename');
const assert = require('assert');

describe('filename module', () => {
  describe('readFileAsync', () => {
    it('should return file content as a string', async () => {
      const filePath = 'path/to/file.txt';
      const expectedContent = 'Hello, World!';
      const result = await readFileAsync(filePath);
      assert.strictEqual(result, expectedContent);
    });

    it('should handle errors gracefully', async () => {
      const filePath = '/nonexistent/path.txt';
      try {
        await readFileAsync(filePath);
        assert.fail('Expected an error to be thrown');
      } catch (err) {
        assert.ok(err.message.includes('Error reading file'));
      }
    });
  });

  describe('readNearReadAsync', () => {
    it('should return trimmed file content as a string', async () => {
      const filePath = 'path/to/file.txt';
      const expectedContent = 'Hello, World!';
      const result = await readNearReadAsync(filePath);
      assert.strictEqual(result.trim(), expectedContent);
    });

    it('should handle errors gracefully', async () => {
      const filePath = '/nonexistent/path.txt';
      try {
        await readNearReadAsync(filePath);
        assert.fail('Expected an error to be thrown');
      } catch (err) {
        assert.ok(err.message.includes('Error reading near the end'));
      }
    });
  });

  describe('navigateElement', () => {
    it('should return file content as an object with data', async () => {
      const elementPath = 'path/to/file.txt';
      const expectedContent = { data: 'Hello, World!' };
      const result = await navigateElement(elementPath);
      assert.deepStrictEqual(result, expectedContent);
    });

    it('should handle errors gracefully', async () => {
      const elementPath = '/nonexistent/path.txt';
      try {
        await navigateElement(elementPath);
        assert.fail('Expected an error to be thrown');
      } catch (err) {
        assert.ok(err.message.includes('Error reading file'));
      }
    });
  });

  describe('writeFile', () => {
    it('should return new content as a string', async () => {
      const filePath = 'path/to/file.txt';
      const text = 'Hello, World!';
      const expectedContent = 'Hello, World!\nHello, World!';
      const result = await writeFile(text, filePath);
      assert.strictEqual(result, expectedContent);
    });

    it('should handle errors gracefully', async () => {
      const filePath = '/nonexistent/path.txt';
      try {
        await writeFile('', filePath);
        assert.fail('Expected an error to be thrown');
      } catch (err) {
        assert.ok(err.message.includes('Error reading file'));
      }
    });
  });

  describe('readFile', () => {
    it('should return file content as a string', async () => {
      const filePath = 'path/to/file.txt';
      const expectedContent = 'Hello, World!';
      const result = await readFile(filePath);
      assert.strictEqual(result, expectedContent);
    });

    it('should handle errors gracefully', async () => {
      const filePath = '/nonexistent/path.txt';
      try {
        await readFile(filePath);
        assert.fail('Expected an error to be thrown');
      } catch (err) {
        assert.ok(err.message.includes('Error reading file'));
      }
    });
  });

  describe('Edge cases', () => {
    it('should handle null input gracefully', async () => {
      const filePath = null;
      try {
        await readFileAsync(filePath);
        assert.fail('Expected an error to be thrown');
      } catch (err) {
        assert.ok(err.message.includes('Error reading file'));
      }
    });

    it('should handle undefined input gracefully', async () => {
      const filePath = undefined;
      try {
        await readFileAsync(filePath);
        assert.fail('Expected an error to be thrown');
      } catch (err) {
        assert.ok(err.message.includes('Error reading file'));
      }
    });

    it('should handle empty string input gracefully', async () => {
      const filePath = '';
      try {
        await readFileAsync(filePath);
        assert.fail('Expected an error to be thrown');
      } catch (err) {
        assert.ok(err.message.includes('Error reading file'));
      }
    });

    it('should handle 0 input gracefully', async () => {
      const filePath = 0;
      try {
        await readFileAsync(filePath);
        assert.fail('Expected an error to be thrown');
      } catch (err) {
        assert.ok(err.message.includes('Error reading file'));
      }
    });

    it('should handle negative number input gracefully', async () => {
      const filePath = -1;
      try {
        await readFileAsync(filePath);
        assert.fail('Expected an error to be thrown');
      } catch (err) {
        assert.ok(err.message.includes('Error reading file'));
      }
    });
  });

  describe('Integration with ui_accessibility.js', () => {
    it('should call ui_accessibility functions correctly', async () => {
      const filePath = 'path/to/file.txt';
      const text = 'Hello, World!';
      const expectedContent = { data: 'Hello, World!' };
      const result = await navigateElement(elementPath);
      assert.deepStrictEqual(result, expectedContent);

      const writeResult = await writeFile(text, filePath);
      assert.strictEqual(writeResult, 'Hello, World!\nHello, World!');

      const readResult = await readFile(filePath);
      assert.strictEqual(readResult, 'Hello, World!');
    });
  });
});
This test suite covers the happy path and edge cases for each export in `filename.js`, including error handling for invalid inputs. It also tests the integration of `navigateElement` with `ui_accessibility.js`.