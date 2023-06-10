import * as path from "path";
import {
    ComplexTypeElement,
    DefinitionsElement,
    ElementElement,
    SchemaElement,
    SequenceElement,
} from "soap/lib/wsdl/elements";
import { open_wsdl } from "soap/lib/wsdl/index";
import { Definition, Method, ParsedWsdl, Port, Service } from "./models/parsed-wsdl";
import { changeCase } from "./utils/change-case";
import { stripExtension } from "./utils/file";
import { reservedKeywords } from "./utils/javascript";
import { Logger } from "./utils/logger";

interface ParserOptions {
    modelNamePreffix: string;
    modelNameSuffix: string;
    maxRecursiveDefinitionName: number;
    generateAttributes: boolean;
}

const defaultOptions: ParserOptions = {
    modelNamePreffix: "",
    modelNameSuffix: "",
    maxRecursiveDefinitionName: 64,
    generateAttributes: false,
};

type VisitedDefinition = {
    name: string;
    parts: object;
    definition: Definition;
};

function findReferenceDefiniton(visited: Array<VisitedDefinition>, definitionParts: object) {
    return visited.find((def) => def.parts === definitionParts);
}

/**
 * parse definition
 * @param parsedWsdl context of parsed wsdl
 * @param name name of definition, will be used as name of interface
 * @param defParts definition's parts - its properties
 * @param stack definitions stack of path to current subdefinition (immutable)
 * @param visitedDefs set of globally visited definitions to avoid circular definitions
 */
function parseDefinition(
    parsedWsdl: ParsedWsdl,
    options: ParserOptions,
    name: string,
    defParts: { [propNameType: string]: any },
    stack: string[],
    visitedDefs: Array<VisitedDefinition>,
    wsdlElementDef: ElementElement,
    rootWsdlDefinitions: SchemaElement
): Definition {
    const defName = changeCase(name, { pascalCase: true });

    Logger.debug(`Parsing Definition ${stack.join(".")}.${name}`);

    let nonCollisionDefName: string;
    try {
        nonCollisionDefName = parsedWsdl.findNonCollisionDefinitionName(defName);
    } catch (err) {
        const e = new Error(`Error for finding non-collision definition name for ${stack.join(".")}.${name}`);
        e.stack.split("\n").slice(0, 2).join("\n") + "\n" + err.stack;
        throw e;
    }

    const definition: Definition = {
        name: `${options.modelNamePreffix}${changeCase(nonCollisionDefName, { pascalCase: true })}${
            options.modelNameSuffix
        }`,
        sourceName: name,
        docs: [name],
        properties: [],
        description: "",
    };

    parsedWsdl.definitions.push(definition); // Must be here to avoid name collision with `findNonCollisionDefinitionName` if sub-definition has same name
    visitedDefs.push({ name: definition.name, parts: defParts, definition }); // NOTE: cache reference to this defintion globally (for avoiding circular references)

    if (options.generateAttributes) {
        getDefinitionAttributes(options, definition, wsdlElementDef);
    }

    if (defParts) {
        // NOTE: `node-soap` has sometimes problem with parsing wsdl files, it includes `defParts.undefined = undefined`
        if ("undefined" in defParts && defParts.undefined === undefined) {
            // TODO: problem while parsing WSDL, maybe report to node-soap
            // TODO: add flag --FailOnWsdlError
            Logger.error({
                message: "Problem while generating a definition file",
                path: stack.join("."),
                parts: defParts,
            });
        } else {
            Object.entries(defParts).forEach(([propName, type]) => {
                let stripedPropName = propName;

                if (propName === "targetNSAlias") {
                    definition.docs.push(`@targetNSAlias \`${type}\``);
                    stripedPropName = null;
                } else if (propName === "targetNamespace") {
                    definition.docs.push(`@targetNamespace \`${type}\``);
                    stripedPropName = null;
                } else if (propName.endsWith("[]")) {
                    stripedPropName = propName.substring(0, propName.length - 2);
                    // Array of
                    if (typeof type === "string") {
                        // primitive type
                        definition.properties.push({
                            kind: "PRIMITIVE",
                            name: stripedPropName,
                            sourceName: propName,
                            description: type,
                            type: "string",
                            isArray: true,
                        });
                    } else if (type instanceof ComplexTypeElement) {
                        // TODO: Finish complex type parsing by updating node-soap
                        definition.properties.push({
                            kind: "PRIMITIVE",
                            name: stripedPropName,
                            sourceName: propName,
                            description: "ComplexType are not supported yet",
                            type: "any",
                            isArray: true,
                        });
                        Logger.warn(`Cannot parse ComplexType '${stack.join(".")}.${name}' - using 'any' type`);
                    } else {
                        // With sub-type
                        const visited = findReferenceDefiniton(visitedDefs, type);
                        if (visited) {
                            // By referencing already declared definition, we will avoid circular references
                            definition.properties.push({
                                kind: "REFERENCE",
                                name: stripedPropName,
                                sourceName: propName,
                                ref: visited.definition,
                                isArray: true,
                            });
                            stripedPropName = null;
                        } else {
                            try {
                                const subWsdlElement = wsdlElementDef
                                    ? findWsdlElement(stripedPropName, wsdlElementDef, rootWsdlDefinitions)
                                    : undefined;

                                const subDefinition = parseDefinition(
                                    parsedWsdl,
                                    options,
                                    stripedPropName,
                                    type,
                                    [...stack, propName],
                                    visitedDefs,
                                    subWsdlElement,
                                    rootWsdlDefinitions
                                );
                                definition.properties.push({
                                    kind: "REFERENCE",
                                    name: stripedPropName,
                                    sourceName: propName,
                                    ref: subDefinition,
                                    isArray: true,
                                });
                            } catch (err) {
                                const e = new Error(
                                    `Error while parsing Subdefinition for '${stack.join(".")}.${name}'`
                                );
                                e.stack.split("\n").slice(0, 2).join("\n") + "\n" + err.stack;
                                throw e;
                            }
                        }
                    }
                } else {
                    if (typeof type === "string") {
                        // primitive type
                        definition.properties.push({
                            kind: "PRIMITIVE",
                            name: propName,
                            sourceName: propName,
                            description: type,
                            type: "string",
                            isArray: false,
                        });
                    } else if (type instanceof ComplexTypeElement) {
                        // TODO: Finish complex type parsing by updating node-soap
                        definition.properties.push({
                            kind: "PRIMITIVE",
                            name: propName,
                            sourceName: propName,
                            description: "ComplexType are not supported yet",
                            type: "any",
                            isArray: false,
                        });
                        Logger.warn(`Cannot parse ComplexType '${stack.join(".")}.${name}' - using 'any' type`);
                    } else {
                        // With sub-type
                        const reference = findReferenceDefiniton(visitedDefs, type);
                        if (reference) {
                            // By referencing already declared definition, we will avoid circular references
                            definition.properties.push({
                                kind: "REFERENCE",
                                name: propName,
                                sourceName: propName,
                                description: "",
                                ref: reference.definition,
                                isArray: false,
                            });
                        } else {
                            try {
                                const subWsdlElement = wsdlElementDef
                                    ? findWsdlElement(propName, wsdlElementDef, rootWsdlDefinitions)
                                    : undefined;

                                const subDefinition = parseDefinition(
                                    parsedWsdl,
                                    options,
                                    propName,
                                    type,
                                    [...stack, propName],
                                    visitedDefs,
                                    subWsdlElement,
                                    rootWsdlDefinitions
                                );
                                definition.properties.push({
                                    kind: "REFERENCE",
                                    name: propName,
                                    sourceName: propName,
                                    ref: subDefinition,
                                    isArray: false,
                                });
                            } catch (err) {
                                const e = new Error(`Error while parsing Subdefinition for ${stack.join(".")}.${name}`);
                                e.stack.split("\n").slice(0, 2).join("\n") + "\n" + err.stack;
                                throw e;
                            }
                        }
                    }
                }
            });
        }
    } else {
        // Empty
    }

    return definition;
}

function findWsdlElement(
    propName: string,
    wsdlElementDef: ElementElement,
    rootWsdlDefinitions: SchemaElement
): ElementElement | undefined {
    for (const element of wsdlElementDef.children) {
        if (element.$name === propName) {
            if (element instanceof ElementElement) {
                if ("$type" in element) {
                    const elementType = element.$type.split(":")[1];
                    const elementTypeDef = Object.entries(rootWsdlDefinitions.complexTypes).find(
                        ([key, _]) => key === elementType
                    );

                    if (elementTypeDef) {
                        return elementTypeDef[1];
                    }
                }
                return element;
            }
            return undefined;
        }

        if ("children" in element) {
            const refElement = findWsdlElement(propName, element as ElementElement, rootWsdlDefinitions);

            if (refElement) {
                return refElement;
            }
        }
    }

    return undefined;
}

function findWsdlElementAttributes(wsdlElementDef?: ElementElement) {
    if (!wsdlElementDef) {
        return [];
    }

    return [
        ...wsdlElementDef.children.filter((element) => element.name === "attribute"),
        ...wsdlElementDef.children
            .filter((el) => el instanceof ComplexTypeElement)
            .flatMap((el) => el.children)
            .filter((element) => element.name === "attribute"),
    ].filter(Boolean);
}

function getDefinitionAttributes(
    options: ParserOptions,
    definition: Definition,
    wsdlElementDef: ElementElement
): Definition | undefined {
    const stripedPropName = definition.name;
    const elementAttributes = findWsdlElementAttributes(wsdlElementDef);

    if (elementAttributes && elementAttributes.length) {
        const allowedTypes = { string: "string", boolean: "boolean", decimal: "number", any: "any" };
        const ignoreAttributes = ["new", "type", "const", "var", "let"];

        const name = "attributes";
        const subAttrDefinition: Definition = {
            name: `${options.modelNamePreffix}${changeCase(stripedPropName, { pascalCase: true })}${
                options.modelNameSuffix
            }Attributes`,
            sourceName: name,
            docs: [`${stripedPropName} ${name}`],
            properties: [],
            description: "",
        };
        elementAttributes
            .filter((attribute) => !ignoreAttributes.includes(attribute.$name))
            .map((attribute) => {
                const originalType = ((attribute as any)?.$type as string) ?? "xs:undefined";
                const type = originalType.split(":")[1];

                subAttrDefinition.properties.push({
                    kind: "PRIMITIVE",
                    name: attribute.$name,
                    sourceName: stripedPropName,
                    description: originalType,
                    type: type in allowedTypes ? allowedTypes[type as keyof typeof allowedTypes] : "any",
                    isArray: false,
                });
            });

        console.debug("Parsing attributes for", stripedPropName, subAttrDefinition);

        definition.properties.push({
            kind: "REFERENCE",
            name: name,
            sourceName: subAttrDefinition.name,
            ref: subAttrDefinition,
            isArray: false,
        });

        return subAttrDefinition;
    }

    return undefined;
}

// TODO: Add logs
// TODO: Add comments for services, ports, methods and client
/**
 * Parse WSDL to domain model `ParsedWsdl`
 * @param wsdlPath - path or url to wsdl file
 */
export async function parseWsdl(wsdlPath: string, options: Partial<ParserOptions>): Promise<ParsedWsdl> {
    const mergedOptions: ParserOptions = {
        ...defaultOptions,
        ...options,
    };
    return new Promise((resolve, reject) => {
        open_wsdl(
            wsdlPath,
            { namespaceArrayElements: false, ignoredNamespaces: ["tns", "targetNamespace", "typeNamespace"] },
            function (err, wsdl) {
                if (err) {
                    return reject(err);
                }
                if (wsdl === undefined) {
                    return reject(new Error("WSDL is undefined"));
                }

                const parsedWsdl = new ParsedWsdl({ maxStack: options.maxRecursiveDefinitionName });
                const filename = path.basename(wsdlPath);
                parsedWsdl.name = changeCase(stripExtension(filename), {
                    pascalCase: true,
                });
                parsedWsdl.wsdlFilename = path.basename(filename);
                parsedWsdl.wsdlPath = path.resolve(wsdlPath);

                const visitedDefinitions: Array<VisitedDefinition> = [];

                const allMethods: Method[] = [];
                const allPorts: Port[] = [];
                const services: Service[] = [];
                for (const [serviceName, service] of Object.entries(wsdl.definitions.services)) {
                    Logger.debug(`Parsing Service ${serviceName}`);
                    const servicePorts: Port[] = []; // TODO: Convert to Array

                    for (const [portName, port] of Object.entries(service.ports)) {
                        Logger.debug(`Parsing Port ${portName}`);
                        const portMethods: Method[] = [];

                        for (const [methodName, method] of Object.entries(port.binding.methods)) {
                            Logger.debug(`Parsing Method ${methodName}`);

                            // TODO: Deduplicate code below by refactoring it to external function. Is it even possible ?
                            let paramName = "request";
                            let inputDefinition: Definition = null; // default type
                            if (method.input) {
                                if (method.input.$name) {
                                    paramName = method.input.$name;
                                }
                                const inputMessage = wsdl.definitions.messages[method.input.$name];

                                const schema = wsdl.definitions.schemas[method.input.targetNamespace];
                                const wsdlComplexTypeDef = schema?.complexTypes[method.input.$name];

                                if (inputMessage.element) {
                                    // TODO: if `$type` not defined, inline type into function declartion (do not create definition file) - wsimport
                                    const typeName = inputMessage.element.$type ?? inputMessage.element.$name;
                                    const type = parsedWsdl.findDefinition(
                                        inputMessage.element.$type ?? inputMessage.element.$name
                                    );

                                    inputDefinition = type
                                        ? type
                                        : parseDefinition(
                                              parsedWsdl,
                                              mergedOptions,
                                              typeName,
                                              inputMessage.parts,
                                              [typeName],
                                              visitedDefinitions,
                                              wsdlComplexTypeDef,
                                              schema
                                          );
                                } else if (inputMessage.parts) {
                                    const type = parsedWsdl.findDefinition(paramName);
                                    inputDefinition = type
                                        ? type
                                        : parseDefinition(
                                              parsedWsdl,
                                              mergedOptions,
                                              paramName,
                                              inputMessage.parts,
                                              [paramName],
                                              visitedDefinitions,
                                              wsdlComplexTypeDef,
                                              schema
                                          );
                                } else {
                                    Logger.debug(
                                        `Method '${serviceName}.${portName}.${methodName}' doesn't have any input defined`
                                    );
                                }
                            }

                            let outputDefinition: Definition = null; // default type, `{}` or `unknown` ?
                            if (method.output) {
                                const outputMessage = wsdl.definitions.messages[method.output.$name];

                                const schema = wsdl.definitions.schemas[method.output.targetNamespace];
                                const wsdlComplexTypeDef = schema?.complexTypes[method.output.$name];

                                if (outputMessage.element) {
                                    // TODO: if `$type` not defined, inline type into function declartion (do not create definition file) - wsimport
                                    const typeName = outputMessage.element.$type ?? outputMessage.element.$name;
                                    const type = parsedWsdl.findDefinition(typeName);
                                    outputDefinition = type
                                        ? type
                                        : parseDefinition(
                                              parsedWsdl,
                                              mergedOptions,
                                              typeName,
                                              outputMessage.parts,
                                              [typeName],
                                              visitedDefinitions,
                                              wsdlComplexTypeDef,
                                              schema
                                          );
                                } else {
                                    const type = parsedWsdl.findDefinition(paramName);
                                    outputDefinition = type
                                        ? type
                                        : parseDefinition(
                                              parsedWsdl,
                                              mergedOptions,
                                              paramName,
                                              outputMessage.parts,
                                              [paramName],
                                              visitedDefinitions,
                                              wsdlComplexTypeDef,
                                              schema
                                          );
                                }
                            }

                            const camelParamName = changeCase(paramName);
                            const portMethod: Method = {
                                name: methodName,
                                paramName: reservedKeywords.includes(camelParamName)
                                    ? `${camelParamName}Param`
                                    : camelParamName,
                                paramDefinition: inputDefinition, // TODO: Use string from generated definition files
                                returnDefinition: outputDefinition, // TODO: Use string from generated definition files
                            };
                            portMethods.push(portMethod);
                            allMethods.push(portMethod);
                        }

                        const servicePort: Port = {
                            name: changeCase(portName, { pascalCase: true }),
                            sourceName: portName,
                            methods: portMethods,
                        };
                        servicePorts.push(servicePort);
                        allPorts.push(servicePort);
                    } // End of Port cycle

                    services.push({
                        name: changeCase(serviceName, { pascalCase: true }),
                        sourceName: serviceName,
                        ports: servicePorts,
                    });
                } // End of Service cycle

                parsedWsdl.services = services;
                parsedWsdl.ports = allPorts;

                return resolve(parsedWsdl);
            }
        );
    });
}
