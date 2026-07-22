import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { create, createFileRegistry, equals, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  FileDescriptorSetSchema,
  FieldDescriptorProto_Label,
  FieldDescriptorProto_Type,
} from "@bufbuild/protobuf/wkt";

const { OPTIONAL, REPEATED } = FieldDescriptorProto_Label;
const { MESSAGE, STRING, UINT32 } = FieldDescriptorProto_Type;

function formRegistry() {
  return createFileRegistry(create(FileDescriptorSetSchema, {
    file: [{
      name: "proto/form.proto",
      package: "meridian.ui.v1",
      syntax: "proto3",
      messageType: [
        {
          name: "TextInput",
          field: [{ name: "default_value", number: 1, type: STRING, label: OPTIONAL }],
        },
        {
          name: "NestedForm",
          field: [{ name: "fields", number: 1, type: MESSAGE, typeName: ".meridian.ui.v1.FormField", label: REPEATED }],
        },
        {
          name: "RepeatedField",
          oneofDecl: [{ name: "element" }],
          field: [
            { name: "scalar", number: 1, type: MESSAGE, typeName: ".meridian.ui.v1.FormField", label: OPTIONAL, oneofIndex: 0 },
            { name: "object", number: 2, type: MESSAGE, typeName: ".meridian.ui.v1.NestedForm", label: OPTIONAL, oneofIndex: 0 },
            { name: "add_label", number: 3, type: STRING, label: OPTIONAL },
            { name: "min_items", number: 4, type: UINT32, label: OPTIONAL },
            { name: "max_items", number: 5, type: UINT32, label: OPTIONAL },
          ],
        },
        {
          name: "FormField",
          oneofDecl: [{ name: "kind" }],
          field: [
            { name: "field_id", number: 1, type: STRING, label: OPTIONAL },
            { name: "label", number: 2, type: STRING, label: OPTIONAL },
            { name: "request_field", number: 3, type: STRING, label: OPTIONAL },
            { name: "text", number: 5, type: MESSAGE, typeName: ".meridian.ui.v1.TextInput", label: OPTIONAL, oneofIndex: 0 },
            { name: "nested", number: 11, type: MESSAGE, typeName: ".meridian.ui.v1.NestedForm", label: OPTIONAL, oneofIndex: 0 },
            { name: "repeated", number: 12, type: MESSAGE, typeName: ".meridian.ui.v1.RepeatedField", label: OPTIONAL, oneofIndex: 0 },
          ],
        },
      ],
    }],
  }));
}

test("form.proto exposes the repeated field arm and requested element shape", () => {
  const source = readFileSync(new URL("../proto/form.proto", import.meta.url), "utf8");
  assert.match(source, /RepeatedField repeated = 12;/);
  assert.doesNotMatch(source, /RepeatedField repeated_field = 12;/);
  assert.match(source, /oneof element\s*\{[\s\S]*FormField scalar = 1[\s\S]*NestedForm object = 2[\s\S]*\}/m);
  assert.match(source, /string add_label = 3\b/);
  assert.match(source, /uint32 min_items = 4\b/);
  assert.match(source, /uint32 max_items = 5\b/);
});

test("FormField repeated object/scalar rows round-trip through protobuf intact", () => {
  const FormField = formRegistry().getMessage("meridian.ui.v1.FormField");
  assert.ok(FormField, "dynamic FormField descriptor should exist");

  const original = create(FormField, {
    fieldId: "groups",
    label: "Groups",
    requestField: "spec.nav.groups",
    kind: {
      case: "repeated",
      value: {
        addLabel: "Add group",
        minItems: 1,
        maxItems: 8,
        element: {
          case: "object",
          value: {
            fields: [
              {
                fieldId: "label",
                label: "Label",
                kind: { case: "text", value: { defaultValue: "Docs" } },
              },
              {
                fieldId: "kinds",
                label: "Kinds",
                kind: {
                  case: "repeated",
                  value: {
                    addLabel: "Add kind",
                    element: {
                      case: "scalar",
                      value: {
                        fieldId: "kind",
                        label: "Kind",
                        kind: { case: "text", value: {} },
                      },
                    },
                  },
                },
              },
            ],
          },
        },
      },
    },
  });

  const decoded = fromBinary(FormField, toBinary(FormField, original));
  assert.ok(equals(FormField, original, decoded));
  assert.deepEqual(decoded, original);
});
