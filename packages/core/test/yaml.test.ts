import { describe, expect, it } from '@siteinquisition/devkit/test';
import { parseYaml } from '../src/yaml.js';

describe('yaml', () => {
  it('reads a typical OpenAPI document', () => {
    const doc = parseYaml(`openapi: 3.0.3
info:
  title: "Shop API"   # comment
  version: 1.0.0
  description: |
    Line one
    Line two
servers:
  - url: https://shop.example.com/api
    description: prod
paths:
  /items/{sku}:
    get:
      operationId: getItem
      tags: [items, catalog]
      parameters:
        - name: sku
          in: path
          required: true
          schema: {type: string, example: 'AB-1'}
      responses:
        '200':
          description: OK
        "404": { description: Not found }
components:
  schemas:
    Base: &base
      type: object
      x-note: >
        folded
        text
    Item:
      <<: *base
      properties:
        price:
          type: number
          example: 9.5
        tags:
          type: array
          items:
            type: string
        empty: ~
        zip: "007"
        flag: yes
`) as Record<string, any>;
    expect(doc.openapi).toBe('3.0.3');
    expect(doc.info.title).toBe('Shop API');
    expect(doc.info.version).toBe('1.0.0');
    expect(doc.info.description).toBe('Line one\nLine two\n');
    expect(doc.servers[0].url).toBe('https://shop.example.com/api');
    expect(doc.servers[0].description).toBe('prod');
    const get = doc.paths['/items/{sku}'].get;
    expect(get.tags).toEqual(['items', 'catalog']);
    expect(get.parameters[0]).toEqual({ name: 'sku', in: 'path', required: true, schema: { type: 'string', example: 'AB-1' } });
    expect(get.responses['200'].description).toBe('OK');
    expect(get.responses['404']).toEqual({ description: 'Not found' });
    const item = doc.components.schemas.Item;
    expect(item.type).toBe('object');
    expect(item['x-note']).toBe('folded text\n');
    expect(item.properties.price.example).toBe(9.5);
    expect(item.properties.tags.items.type).toBe('string');
    expect(item.properties.empty).toBe(null);
    expect(item.properties.zip).toBe('007');
    expect(item.properties.flag).toBe('yes');
  });

  it('handles nested lists, keep chomping and documents markers', () => {
    const doc = parseYaml(`---
a:
- - 1
  - 2
- x: 1
  y:
    - z
b: |+
  keep

c: 'it''s'
d: "tab\\tnew\\nline"
e: plain text
  continued
`) as Record<string, any>;
    expect(doc.a).toEqual([[1, 2], { x: 1, y: ['z'] }]);
    expect(doc.b).toBe('keep\n\n');
    expect(doc.c).toBe("it's");
    expect(doc.d).toBe('tab\tnew\nline');
    expect(doc.e).toBe('plain text continued');
  });

  it('reports the line of a bad document', () => {
    expect(() => parseYaml('a: 1\n b: 2\n')).toThrow('line 2');
  });
});
