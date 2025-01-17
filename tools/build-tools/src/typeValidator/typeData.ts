/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { Node, Project, ts } from "ts-morph";
import * as fs from "fs";
import { getPackageDetails, PackageDetails } from "./packageJson";

export interface PackageAndTypeData{
    packageDetails: PackageDetails;
    typeData: TypeData[];
}

export interface TypeData{
    readonly name: string;
    readonly kind: string;
    readonly node: Node;
}

export function hasDocTag(data: TypeData, tagName: "deprecated" | "internal"){
    if(Node.isJSDocableNode(data.node)) {
        for(const doc of data.node.getJsDocs()){
            for(const tag of doc.getTags()){
                if(tag.getTagName() === tagName){
                    return true;
                }
            }
        }
    }
    return false;
}

function getNodeTypeData(node:Node, namespacePrefix?:string): TypeData[]{

    /*
        handles namespaces e.g.
        export namespace foo{
            export type first: "first";
            export type second: "second";
        }
        this will prefix foo and generate two type data:
        foo.first and foo.second
    */
    if (Node.isNamespaceDeclaration(node)){
        const typeData: TypeData[]=[];
        for(const s of node.getStatements()){
            typeData.push(...getNodeTypeData(s, node.getName()));
        }
        return typeData;
    }

    /*
        handles variable statements: const foo:number=0, bar:number = 0;
        this just grabs the declarations: foo:number=0 and bar:number
        which we can make type data from
    */
    if(Node.isVariableStatement(node)){
        const typeData: TypeData[]=[];
        for(const dec of node.getDeclarations()){
            typeData.push(...getNodeTypeData(dec, namespacePrefix));
        }
        return typeData
    }

    if(Node.isClassDeclaration(node)
        || Node.isEnumDeclaration(node)
        || Node.isInterfaceDeclaration(node)
        || Node.isTypeAliasDeclaration(node)
        || Node.isVariableDeclaration(node)
        || Node.isFunctionDeclaration(node)){

        const name = namespacePrefix !== undefined
            ? `${namespacePrefix}.${node.getName()}`
            : node.getName()!;

        return [{
            name,
            kind: node.getKindName(),
            node,
        }];
    }

    throw new Error(`Unknown Export Kind: ${node.getKindName()}`)
}

export function toTypeString(prefix: string, typeData: TypeData){
    const node = typeData.node;
    let typeParams: string | undefined;
    if(Node.isInterfaceDeclaration(node)
        || Node.isTypeAliasDeclaration(node)
        || Node.isClassDeclaration(node)
    ){
        // does the type take generics that don't have defaults?
        if(node.getTypeParameters().length > 0
            && node.getTypeParameters().some((tp)=>tp.getDefault() === undefined)
        ){
            // it's really hard to build the right type for a generic,
            // so for now we'll just pass any, as it will always work
            typeParams = `<${node.getTypeParameters().map(()=>"any").join(",")}>`;
        }
    }

    const typeStringBase =`${prefix}.${typeData.name}${typeParams ?? ""}`;
    switch(node.getKind()){
        case ts.SyntaxKind.ClassDeclaration:
            // turn the class into a type by not omitting anything
            // this will expose all public props, and validate the
            // interfaces matches
            return `Omit<${typeStringBase},"">`;

        case ts.SyntaxKind.VariableDeclaration:
        case ts.SyntaxKind.FunctionDeclaration:
            // turn variables and functions into types
            return `typeof ${typeStringBase}`;

        default:
            return typeStringBase;
    }
}

function tryFindDependencyPath(packageDir: string, dependencyName: string) {
    // for lerna mono-repos we may need to look for the hoisted packages
    //
    let testPath = packageDir;
    while(!fs.existsSync(`${testPath}/node_modules/${dependencyName}/package.json`)
        && !fs.existsSync(`${testPath}/lerna.json`
    )){
        testPath += "/.."
    }
    return `${testPath}/node_modules/${dependencyName}`
}

export function generateTypeDataForProject(packageDir: string, dependencyName: string | undefined): PackageAndTypeData {

    const basePath = dependencyName === undefined
        ? packageDir
        : tryFindDependencyPath(packageDir, dependencyName);

    const tsConfigPath =`${basePath}/tsconfig.json`

    if(!fs.existsSync(tsConfigPath)){
        throw new Error(`Tsconfig json does not exist: ${tsConfigPath}.\nYou may need to install the package via npm install in the package dir.`)
    }

    const packageDetails = getPackageDetails(basePath);

    const project = new Project({
        skipFileDependencyResolution: true,
        tsConfigFilePath: tsConfigPath,
    });

    const file = project.getSourceFile("index.ts")
    if(file == undefined){
        throw new Error("index.ts does not exist in package source.\nYou may need to install the package via npm install in the package dir.");
    }
    const typeData: TypeData[]=[];

    const exportedDeclarations = file.getExportedDeclarations();
    for(const declarations of exportedDeclarations.values()){
        for(const dec of declarations){
            typeData.push(...getNodeTypeData(dec));
        }
    }
    return {
        packageDetails,
        typeData: typeData.sort((a,b)=>a.name.localeCompare(b.name)),
    };
}
