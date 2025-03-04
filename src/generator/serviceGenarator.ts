import { readFileSync } from 'fs';
import { globSync } from 'glob';
import {
  Dictionary,
  camelCase,
  entries,
  filter,
  find,
  forEach,
  isArray,
  isEmpty,
  isFunction,
  isObject,
  keys,
  map,
  upperFirst,
} from 'lodash';
import { minimatch } from 'minimatch';
import nunjucks from 'nunjucks';
import { join } from 'path';
import { sync as rimrafSync } from 'rimraf';

import {
  PriorityRule,
  SchemaObjectFormat,
  SchemaObjectType,
  displayReactQueryMode,
} from '../config';
import type { GenerateServiceProps } from '../index';
import log from '../log';
import {
  ArraySchemaObject,
  ContentObject,
  ISchemaObject,
  OpenAPIObject,
  OperationObject,
  ParameterObject,
  PathItemObject,
  ReferenceObject,
  RequestBodyObject,
  ResponseObject,
  ResponsesObject,
  SchemaObject,
} from '../type';
import {
  DEFAULT_PATH_PARAM,
  DEFAULT_SCHEMA,
  LangType,
  TypescriptFileType,
  displayEnumLabelFileName,
  displayReactQueryFileName,
  displayTypeLabelFileName,
  interfaceFileName,
  lineBreakReg,
  methods,
  numberEnum,
  parametersIn,
  parametersInsEnum,
  schemaFileName,
  serviceEntryFileName,
} from './config';
import { writeFile } from './file';
import { patchSchema } from './patchSchema';
import {
  APIDataType,
  ControllerType,
  ICustomParameterObject,
  ICustomSchemaObject,
  IPropObject,
  ISchemaItem,
  ITypeItem,
  ITypescriptFileType,
  TagAPIDataType,
} from './type';
import {
  capitalizeFirstLetter,
  genDefaultFunctionName,
  getBasePrefix,
  getDefaultFileTag,
  getDefaultType,
  getFinalFileName,
  getLastRefName,
  getRefName,
  handleDuplicateTypeNames,
  isAllNumber,
  isAllNumeric,
  isArraySchemaObject,
  isBinaryArraySchemaObject,
  isNonArraySchemaObject,
  isReferenceObject,
  isSchemaObject,
  markAllowedSchema,
  parseDescriptionEnum,
  replaceDot,
  resolveFunctionName,
  resolveRefs,
  resolveTypeName,
  stripDot,
} from './util';

export default class ServiceGenerator {
  protected apiData: TagAPIDataType = {};
  protected classNameList: ControllerType[] = [];
  protected config: GenerateServiceProps;
  protected openAPIData: OpenAPIObject;
  protected schemaList: ISchemaItem[] = [];

  constructor(config: GenerateServiceProps, openAPIData: OpenAPIObject) {
    this.config = {
      templatesFolder: join(__dirname, '../../', 'templates'),
      ...config,
    };
    this.generateInfoLog();

    const includeTags = this.config?.includeTags || [];
    const includePaths = this.config?.includePaths || [];
    const excludeTags = this.config?.excludeTags || [];
    const excludePaths = this.config?.excludePaths || [];

    const priorityRule: PriorityRule = PriorityRule[config.priorityRule];

    if (this.config.hook?.afterOpenApiDataInited) {
      this.openAPIData =
        this.config.hook.afterOpenApiDataInited(openAPIData) || openAPIData;
    } else {
      this.openAPIData = openAPIData;
    }

    // 用 tag 分组 paths, { [tag]: [pathMap, pathMap] }
    outerLoop: for (const pathKey in this.openAPIData.paths) {
      // 这里判断paths
      switch (priorityRule) {
        case PriorityRule.include: {
          // includePaths and includeTags is empty, 直接跳过
          if (isEmpty(includeTags) && isEmpty(includePaths)) {
            this.log('priorityRule include need includeTags or includePaths');
            break outerLoop;
          }

          if (
            !isEmpty(includePaths) &&
            !this.validateRegexp(pathKey, includePaths)
          ) {
            continue;
          }
          break;
        }
        case PriorityRule.exclude: {
          if (this.validateRegexp(pathKey, excludePaths)) {
            continue;
          }
          break;
        }
        case PriorityRule.both: {
          // includePaths and includeTags is empty，直接跳过
          if (isEmpty(includeTags) && isEmpty(includePaths)) {
            this.log('priorityRule both need includeTags or includePaths');
            break outerLoop;
          }

          const outIncludePaths =
            !isEmpty(includePaths) &&
            !this.validateRegexp(pathKey, includePaths);
          const inExcludePaths =
            !isEmpty(excludePaths) &&
            this.validateRegexp(pathKey, excludePaths);

          if (outIncludePaths || inExcludePaths) {
            continue;
          }
          break;
        }
        default:
          throw new Error(
            'priorityRule must be "include" or "exclude" or "include"'
          );
      }

      const pathItem = this.openAPIData.paths[pathKey];

      forEach(methods, (method) => {
        const operationObject = pathItem[method] as OperationObject;

        if (!operationObject) {
          return;
        }

        const hookCustomFileNames =
          this.config.hook?.customFileNames || getDefaultFileTag;
        const tags = hookCustomFileNames(operationObject, pathKey, method);

        // 这里判断tags
        tags.forEach((tag) => {
          if (!tag) {
            return;
          }

          const tagLowerCase = tag.toLowerCase();

          if (priorityRule === PriorityRule.include) {
            // includeTags 为空，不会匹配任何path，故跳过
            if (isEmpty(includeTags)) {
              this.log('priorityRule include need includeTags or includePaths');
              return;
            }

            if (!this.validateRegexp(tagLowerCase, includeTags)) {
              return;
            }
          }

          if (priorityRule === PriorityRule.exclude) {
            if (this.validateRegexp(tagLowerCase, excludeTags)) {
              return;
            }
          }

          if (priorityRule === PriorityRule.both) {
            // includeTags is empty 没有配置, 直接跳过
            if (isEmpty(includeTags)) {
              this.log('priorityRule both need includeTags or includePaths');
              return;
            }

            const outIncludeTags =
              !isEmpty(includeTags) &&
              !this.validateRegexp(tagLowerCase, includeTags);
            const inExcludeTags =
              !isEmpty(excludeTags) &&
              this.validateRegexp(tagLowerCase, excludeTags);

            if (outIncludeTags || inExcludeTags) {
              return;
            }
          }

          const tagKey = this.config.isCamelCase
            ? camelCase(resolveTypeName(tag))
            : resolveTypeName(tag);

          if (!this.apiData[tagKey]) {
            this.apiData[tagKey] = [];
          }

          this.apiData[tagKey].push({
            path: pathKey,
            method,
            ...operationObject,
          });
        });
      });
    }
  }

  public genFile() {
    try {
      globSync(`${this.config.serversPath}/**/*`)
        .filter((item) => !item.includes('_deperated'))
        .forEach((item) => {
          rimrafSync(item);
        });
    } catch (error) {
      log(`🚥 api 生成失败: ${error}`);
    }

    const isOnlyGenTypeScriptType = this.config.isOnlyGenTypeScriptType;
    const isGenJavaScript = this.config.isGenJavaScript;
    const reactQueryMode = this.config.reactQueryMode;
    const reactQueryFileName = displayReactQueryFileName(reactQueryMode);

    // 处理重复的 typeName
    const interfaceTPConfigs = this.getInterfaceTPConfigs();
    handleDuplicateTypeNames(interfaceTPConfigs);

    // 生成 ts 类型声明
    if (!isGenJavaScript) {
      this.genFileFromTemplate(
        `${interfaceFileName}.ts`,
        TypescriptFileType.interface,
        {
          nullable: this.config.nullable,
          list: interfaceTPConfigs,
        }
      );
    }

    // 生成枚举翻译
    const enums = filter(interfaceTPConfigs, (item) => item.isEnum);
    if (!isGenJavaScript && !isOnlyGenTypeScriptType && !isEmpty(enums)) {
      this.genFileFromTemplate(
        `${displayEnumLabelFileName}.ts`,
        TypescriptFileType.displayEnumLabel,
        {
          list: enums,
          namespace: this.config.namespace,
          interfaceFileName: interfaceFileName,
        }
      );
    }

    const displayTypeLabels = filter(
      interfaceTPConfigs,
      (item) => !item.isEnum
    );
    // 生成 type 翻译
    if (
      !isGenJavaScript &&
      !isOnlyGenTypeScriptType &&
      this.config.isDisplayTypeLabel &&
      !isEmpty(displayTypeLabels)
    ) {
      this.genFileFromTemplate(
        `${displayTypeLabelFileName}.ts`,
        TypescriptFileType.displayTypeLabel,
        {
          list: displayTypeLabels,
          namespace: this.config.namespace,
          interfaceFileName: interfaceFileName,
        }
      );
    }

    if (!isOnlyGenTypeScriptType) {
      const prettierError = [];

      // 生成 service controller 文件
      this.getServiceTPConfigs().forEach((tp) => {
        const hasError = this.genFileFromTemplate(
          isGenJavaScript
            ? getFinalFileName(`${tp.className}.js`)
            : getFinalFileName(`${tp.className}.ts`),
          TypescriptFileType.serviceController,
          {
            namespace: this.config.namespace,
            requestOptionsType: this.config.requestOptionsType,
            requestImportStatement: this.config.requestImportStatement,
            interfaceFileName: interfaceFileName,
            ...tp,
          }
        );

        prettierError.push(hasError);

        if (this.config.isGenReactQuery) {
          this.genFileFromTemplate(
            isGenJavaScript
              ? getFinalFileName(`${tp.className}.${reactQueryFileName}.js`)
              : getFinalFileName(`${tp.className}.${reactQueryFileName}.ts`),
            TypescriptFileType.reactQuery,
            {
              namespace: this.config.namespace,
              requestOptionsType: this.config.requestOptionsType,
              requestImportStatement: this.config.requestImportStatement,
              interfaceFileName: interfaceFileName,
              reactQueryModePackageName: displayReactQueryMode(reactQueryMode),
              ...tp,
            }
          );
        }
      });

      if (prettierError.includes(true)) {
        log(
          '🚥 格式化失败，请检查 service controller 文件内可能存在的语法错误'
        );
      }
    }

    if (
      !isOnlyGenTypeScriptType &&
      this.config.isGenJsonSchemas &&
      !isEmpty(this.schemaList)
    ) {
      // 处理重复的 schemaName
      handleDuplicateTypeNames(this.schemaList);
      // 生成 schema 文件
      this.genFileFromTemplate(
        isGenJavaScript ? `${schemaFileName}.js` : `${schemaFileName}.ts`,
        TypescriptFileType.schema,
        {
          list: this.schemaList,
        }
      );
    }

    // 生成 service index 文件
    this.genFileFromTemplate(
      isGenJavaScript
        ? `${serviceEntryFileName}.js`
        : `${serviceEntryFileName}.ts`,
      TypescriptFileType.serviceIndex,
      {
        list: this.classNameList,
        namespace: this.config.namespace,
        interfaceFileName: interfaceFileName,
        genType: isGenJavaScript ? LangType.js : LangType.ts,
        isGenJsonSchemas:
          !isOnlyGenTypeScriptType &&
          this.config.isGenJsonSchemas &&
          !isEmpty(this.schemaList),
        schemaFileName: schemaFileName,
        isDisplayEnumLabel: !isOnlyGenTypeScriptType && !isEmpty(enums),
        displayEnumLabelFileName: displayEnumLabelFileName,
        isGenReactQuery: this.config.isGenReactQuery,
        reactQueryFileName,
        isDisplayTypeLabel:
          !isOnlyGenTypeScriptType &&
          this.config.isDisplayTypeLabel &&
          !isEmpty(displayTypeLabels),
        displayTypeLabelFileName: displayTypeLabelFileName,
      }
    );

    // 打印日志
    log('✅ 成功生成 api 文件');
  }

  private getInterfaceTPConfigs() {
    const schemas = this.openAPIData.components?.schemas;
    const lastTypes: Array<ITypeItem> = [];
    const includeTags = this.config?.includeTags || [];

    // 强行替换掉请求参数params的类型，生成方法对应的 xxxxParams 类型
    keys(this.openAPIData.paths).forEach((pathKey) => {
      const pathItem = this.openAPIData.paths[pathKey] as PathItemObject;

      forEach(methods, (method) => {
        const operationObject = pathItem[method] as OperationObject;
        const hookCustomFileNames =
          this.config.hook?.customFileNames || getDefaultFileTag;

        if (!operationObject) {
          return;
        }

        const tags = hookCustomFileNames(operationObject, pathKey, method);

        if (isEmpty(includeTags) || (!isEmpty(includeTags) && isEmpty(tags))) {
          return;
        }

        const flag = this.validateRegexp(
          filter(
            map(tags, (tag) =>
              tag?.toLowerCase ? tag.toLowerCase() : undefined
            ),
            (tag) => !!tag
          ),
          includeTags
        );

        if (!flag) {
          return;
        }

        // 筛选出 pathItem 包含的 $ref 对应的schema
        markAllowedSchema(JSON.stringify(pathItem), this.openAPIData);

        operationObject.parameters = operationObject.parameters?.filter(
          (item: ParameterObject) => item?.in !== `${parametersInsEnum.header}`
        );
        const props = [] as IPropObject[];

        operationObject.parameters?.forEach((parameter: ParameterObject) => {
          props.push({
            name: parameter.name,
            desc: (parameter.description ?? '').replace(lineBreakReg, ''),
            required: parameter.required || false,
            type: this.getType(parameter.schema),
          });
        });

        // parameters may be in path
        pathItem.parameters?.forEach((parameter: ParameterObject) => {
          props.push({
            name: parameter.name,
            desc: (parameter.description ?? '').replace(lineBreakReg, ''),
            required: parameter.required,
            type: this.getType(parameter.schema),
          });
        });

        const typeName = this.getFunctionParamsTypeName({
          ...operationObject,
          method,
          path: pathKey,
        });

        if (props.length > 0 && typeName) {
          lastTypes.push({
            typeName,
            type: 'Record<string, unknown>',
            props: [props],
            isEnum: false,
          });
        }
      });
    });

    keys(schemas).forEach((schemaKey) => {
      const schema = schemas[schemaKey] as ISchemaObject;

      // 判断哪些 schema 需要添加进 type, schemas 渲染数组
      if (!(schema as ICustomSchemaObject)?.isAllowed) {
        return;
      }

      const result = this.resolveObject(schema) as Dictionary<
        string | boolean | IPropObject[][]
      >;

      const getDefinesType = (): string => {
        if (result?.type) {
          return (schema as SchemaObject).type === 'object'
            ? SchemaObjectType.object
            : numberEnum.includes(result.type as string)
              ? SchemaObjectType.number
              : (result.type as string);
        }

        return 'Record<string, unknown>';
      };

      // 解析 props 属性中的枚举
      if (isArray(result.props) && result.props.length > 0) {
        forEach(result.props[0], (item) => {
          if (item.enum) {
            const enumObj = this.resolveEnumObject(
              item as unknown as SchemaObject
            );

            lastTypes.push({
              typeName: `${upperFirst(item.name)}Enum`,
              type: enumObj.type,
              props: [],
              isEnum: enumObj.isEnum,
              displayLabelFuncName: camelCase(`display-${item.name}-Enum`),
              enumLabelType: enumObj.enumLabelType,
            });
          }
        });
      }

      const isEnum = result.isEnum as boolean;
      const typeName = resolveTypeName(schemaKey);

      if (typeName) {
        lastTypes.push({
          typeName,
          type: getDefinesType(),
          props: (result.props || []) as IPropObject[][],
          isEnum,
          displayLabelFuncName: isEnum
            ? camelCase(`display-${typeName}-Enum`)
            : '',
          enumLabelType: isEnum ? (result.enumLabelType as string) : '',
        });
      }

      if (this.config.isGenJsonSchemas) {
        this.schemaList.push({
          typeName: `$${resolveTypeName(schemaKey)}`,
          type: JSON.stringify(
            patchSchema<SchemaObject>(
              schema,
              this.openAPIData.components?.schemas
            )
          ),
        });
      }
    });

    return lastTypes?.sort((a, b) => a.typeName.localeCompare(b.typeName)); // typeName排序
  }

  private getServiceTPConfigs() {
    return keys(this.apiData)
      .map((tag, index) => {
        // functionName tag 级别防重
        const tmpFunctionRD: Record<string, number> = {};
        const genParams = this.apiData[tag]
          .filter(
            (api) =>
              // 暂不支持变量, path 需要普通前缀请使用例如: apiPrefix: "`api`", path 需要变量前缀请使用例如: apiPrefix: "api"
              !api.path.includes('${')
          )
          .map((api) => {
            const newApi = api as APIDataType & Dictionary<unknown>;

            try {
              const params =
                this.getParamsTP(newApi.parameters, newApi.path) || {};
              const body = this.getBodyTP(
                newApi.requestBody as RequestBodyObject
              );
              const response = this.getResponseTP(newApi.responses);
              const file = this.getFileTP(
                newApi.requestBody as RequestBodyObject
              );
              let formData = false;

              if (body?.mediaType?.includes('form-data') || file) {
                formData = true;
              }

              let functionName = this.getFunctionName(newApi);

              if (functionName && tmpFunctionRD[functionName]) {
                functionName = `${functionName}_${(tmpFunctionRD[functionName] += 1)}`;
              } else if (functionName) {
                tmpFunctionRD[functionName] = 1;
              }

              let formattedPath = newApi.path.replace(
                /:([^/]*)|{([^}]*)}/gi,
                (_, str, str2) => `$\{${str || str2}}`
              );

              // 为 path 中的 params 添加 alias
              const escapedPathParams = map(
                params.path,
                (item, index: number) => ({
                  ...item,
                  alias: `param${index}`,
                })
              );

              if (escapedPathParams.length) {
                escapedPathParams.forEach((param) => {
                  formattedPath = formattedPath.replace(
                    `$\{${param.name}}`,
                    `$\{${param.alias}}`
                  );
                });
              }

              const finalParams =
                escapedPathParams && escapedPathParams.length
                  ? { ...params, path: escapedPathParams }
                  : params;

              // 处理 query 中的复杂对象
              if (finalParams?.query) {
                finalParams.query = finalParams.query.map((item) => ({
                  ...item,
                  isComplexType: (item as ICustomParameterObject).isObject,
                }));
              }

              // 处理 api path 前缀
              const getPrefixPath = () => {
                if (!this.config.apiPrefix) {
                  return formattedPath;
                }

                // 静态 apiPrefix
                const prefix = isFunction(this.config.apiPrefix)
                  ? `${this.config.apiPrefix({
                      path: formattedPath,
                      method: newApi.method,
                      namespace: tag,
                      functionName,
                    })}`.trim()
                  : this.config.apiPrefix.trim();

                if (!prefix) {
                  return formattedPath;
                }

                if (
                  prefix.startsWith("'") ||
                  prefix.startsWith('"') ||
                  prefix.startsWith('`')
                ) {
                  const finalPrefix = prefix.slice(1, prefix.length - 1);
                  const firstPath = formattedPath.split('/')[1];

                  if (
                    firstPath === finalPrefix ||
                    `/${firstPath}` === finalPrefix
                  ) {
                    return formattedPath;
                  }

                  return `${finalPrefix}${formattedPath}`;
                }

                // prefix 变量
                return `$\{${prefix}}${formattedPath}`;
              };

              return {
                ...newApi,
                functionName: this.config.isCamelCase
                  ? camelCase(functionName)
                  : functionName,
                typeName: this.getFunctionParamsTypeName(newApi),
                path: getPrefixPath(),
                pathInComment: formattedPath.replace(/\*/g, '&#42;'),
                apifoxRunLink: newApi?.['x-run-in-apifox'],
                hasPathVariables: formattedPath.includes('{'),
                hasApiPrefix: !!this.config.apiPrefix,
                method: newApi.method,
                // 如果 functionName 和 summary 相同，则不显示 summary
                desc:
                  functionName === newApi.summary
                    ? (newApi.description || '').replace(lineBreakReg, '')
                    : [
                        newApi.summary,
                        newApi.description,
                        (newApi.responses?.default as ResponseObject)
                          ?.description
                          ? `返回值: ${(newApi.responses?.default as ResponseObject).description}`
                          : '',
                      ]
                        .filter((s) => s)
                        .join(' ')
                        .replace(lineBreakReg, ''),
                hasHeader: !!params?.header || !!body?.mediaType,
                params: finalParams,
                hasParams: Boolean(keys(finalParams).length),
                options:
                  this.config.hook?.customOptionsDefaultValue?.(newApi) || {},
                body,
                file,
                hasFormData: formData,
                response,
              };
            } catch (error) {
              console.error('[GenSDK] gen service param error:', error);
              throw error;
            }
          })
          // 排序下，防止git乱
          .sort((a, b) => a.path.localeCompare(b.path));

        const fileName = replaceDot(tag) || `api${index}`;
        let className = fileName;

        if (this.config.hook?.customClassName) {
          className = this.config.hook.customClassName(tag);
        }

        if (genParams.length) {
          this.classNameList.push({
            fileName: className,
            controllerName: className,
          });
        }

        return {
          genType: this.config.isGenJavaScript ? LangType.js : LangType.ts,
          className,
          instanceName: `${fileName[0]?.toLowerCase()}${fileName.slice(1)}`,
          list: genParams,
        };
      })
      .filter((item) => !!item?.list?.length);
  }

  private genFileFromTemplate(
    fileName: string,
    type: ITypescriptFileType,
    params: Record<string, unknown>
  ): boolean {
    try {
      const template = this.getTemplate(type);
      // 设置输出不转义
      const env = nunjucks.configure({
        autoescape: false,
      });

      env.addFilter('capitalizeFirst', capitalizeFirstLetter);

      return writeFile(
        this.config.serversPath,
        fileName,
        nunjucks.renderString(template, { disableTypeCheck: false, ...params })
      );
    } catch (error) {
      console.error('[GenSDK] file gen fail:', fileName, 'type:', type);
      throw error;
    }
  }

  private getTemplate(type: ITypescriptFileType): string {
    return readFileSync(
      join(this.config.templatesFolder, `${type}.njk`),
      'utf8'
    );
  }

  private getFunctionName(data: APIDataType) {
    // 获取路径相同部分
    const pathBasePrefix = getBasePrefix(keys(this.openAPIData.paths));

    return this.config.hook && this.config.hook.customFunctionName
      ? this.config.hook.customFunctionName(data)
      : data.operationId
        ? resolveFunctionName(stripDot(data.operationId), data.method)
        : data.method + genDefaultFunctionName(data.path, pathBasePrefix);
  }

  private getType(schemaObject: ISchemaObject, namespace?: string) {
    const customTypeHookFunc = this.config.hook?.customType;
    const schemas = this.openAPIData.components?.schemas;

    if (customTypeHookFunc) {
      const type = customTypeHookFunc({
        schemaObject,
        namespace,
        schemas,
        originGetType: getDefaultType,
      });

      if (typeof type === 'string') {
        return type;
      }
    }

    return getDefaultType(schemaObject, namespace, schemas);
  }

  private getFunctionParamsTypeName(data: APIDataType) {
    const namespace = this.config.namespace ? `${this.config.namespace}.` : '';
    const typeName =
      this.config?.hook?.customTypeName?.(data) || this.getFunctionName(data);

    return resolveTypeName(`${namespace}${typeName ?? data.operationId}Params`);
  }

  private getBodyTP(requestBody: RequestBodyObject) {
    const reqBody = this.resolveRefObject(requestBody);

    if (isEmpty(reqBody)) {
      return null;
    }

    const reqContent: ContentObject = reqBody.content;

    if (!isObject(reqContent)) {
      return null;
    }

    let mediaType = keys(reqContent)[0];
    const schema: SchemaObject =
      (reqContent[mediaType]?.schema as SchemaObject) || DEFAULT_SCHEMA;

    if (mediaType === '*/*') {
      mediaType = '';
    }

    // 如果 requestBody 有 required 属性，则正常展示；如果没有，默认非必填
    const required =
      typeof requestBody?.required === 'boolean' ? requestBody.required : false;

    if (schema.type === 'object' && schema.properties) {
      const propertiesList = keys(schema.properties)
        .map((propertyKey) => {
          const propertyObj = schema.properties[
            propertyKey
          ] as ArraySchemaObject;

          if (
            propertyObj &&
            ![SchemaObjectFormat.binary, SchemaObjectFormat.base64].includes(
              propertyObj.format as SchemaObjectFormat
            ) &&
            !isBinaryArraySchemaObject(propertyObj)
          ) {
            // 测试了很多用例，很少有用例走到这里
            return {
              key: propertyKey,
              schema: {
                ...(propertyObj as ArraySchemaObject),
                type: this.getType(propertyObj, this.config.namespace),
                required: schema.required?.includes(propertyKey) ?? false,
              },
            };
          }

          return null;
        })
        .filter((p) => p);

      return {
        mediaType,
        ...schema,
        required,
        propertiesList,
      };
    }

    return {
      mediaType,
      required,
      type: this.getType(schema, this.config.namespace),
    };
  }

  private getFileTP(requestBody: RequestBodyObject) {
    const reqBody = this.resolveRefObject(requestBody);

    if (reqBody?.content?.['multipart/form-data']) {
      const ret = this.resolveFileTP(
        reqBody.content['multipart/form-data'].schema as SchemaObject
      );

      return ret.length > 0 ? ret : null;
    }

    return null;
  }

  private resolveFileTP(obj: SchemaObject) {
    let ret = [] as Array<{ title: string; multiple: boolean }>;
    const resolved = this.resolveObject(obj) as ITypeItem;
    const props =
      (resolved.props?.length > 0 &&
        resolved.props[0].filter(
          (p) =>
            p.format === 'binary' ||
            p.format === 'base64' ||
            isBinaryArraySchemaObject(p)
        )) ||
      [];

    if (props.length > 0) {
      ret = props.map((p) => {
        // 这里 p.type 是自定义type, 注意别混淆
        return {
          title: p.name,
          multiple:
            p.type === `${SchemaObjectType.array}` ||
            p.type === `${SchemaObjectType.stringArray}`,
        };
      });
    }

    if (resolved.type)
      ret = [...ret, ...this.resolveFileTP(resolved.type as SchemaObject)];

    return ret;
  }

  private getResponseTP(responses: ResponsesObject = {}) {
    const { components } = this.openAPIData;
    const response: ResponseObject | undefined =
      responses &&
      this.resolveRefObject(
        responses.default || responses['200'] || responses['201']
      );
    const defaultResponse = {
      mediaType: '*/*',
      type: 'unknown',
    };

    if (!response) {
      return defaultResponse;
    }

    const resContent: ContentObject | undefined = response.content;
    const resContentMediaTypes = keys(resContent);
    const mediaType = resContentMediaTypes.includes('application/json')
      ? 'application/json'
      : resContentMediaTypes[0]; // 优先使用 application/json

    if (!isObject(resContent) || !mediaType) {
      return defaultResponse;
    }

    let schema = (resContent[mediaType].schema ||
      DEFAULT_SCHEMA) as SchemaObject;

    if (isReferenceObject(schema)) {
      const refName = getLastRefName(schema.$ref);
      const childrenSchema = components.schemas[refName];

      if (isNonArraySchemaObject(childrenSchema) && this.config.dataFields) {
        schema = (this.config.dataFields
          .map((field) => childrenSchema.properties[field])
          .filter(Boolean)?.[0] ||
          resContent[mediaType].schema ||
          DEFAULT_SCHEMA) as SchemaObject;
      }
    }

    if (isSchemaObject(schema)) {
      keys(schema.properties).map((fieldName) => {
        schema.properties[fieldName]['required'] =
          schema.required?.includes(fieldName) ?? false;
      });
    }

    return {
      mediaType,
      type: this.getType(schema, this.config.namespace),
    };
  }

  private getParamsTP(
    parameters: (ParameterObject | ReferenceObject)[] = [],
    path: string = null
  ): Record<string, ParameterObject[]> {
    const templateParams: Record<string, ParameterObject[]> = {};

    if (parameters?.length) {
      forEach(parametersIn, (source) => {
        const params = parameters
          .map((p) => this.resolveRefObject(p))
          .filter((p) => p.in === source)
          .map((p) => {
            const isDirectObject =
              ((p.schema as SchemaObject)?.type === 'object' ||
                (p as unknown as SchemaObject).type) === 'object';
            const refName = getLastRefName(
              (p.schema as ReferenceObject)?.$ref ||
                (p as unknown as ReferenceObject).$ref
            );
            const deRefObj =
              entries(this.openAPIData.components?.schemas).find(
                ([k]) => k === refName
              ) || [];
            const isRefObject =
              (deRefObj[1] as SchemaObject)?.type === 'object' &&
              !isEmpty((deRefObj[1] as SchemaObject)?.properties);

            return {
              ...p,
              isObject: isDirectObject || isRefObject,
              type: this.getType(
                p.schema || DEFAULT_SCHEMA,
                this.config.namespace
              ),
            } as ICustomParameterObject;
          });

        if (params.length) {
          templateParams[source] = params;
        }
      });
    }

    if (path && path.length > 0) {
      const regex = /\{(\w+)\}/g;
      templateParams.path = templateParams.path || [];
      let match: RegExpExecArray | null = null;

      while ((match = regex.exec(path))) {
        if (!templateParams.path.some((p) => p.name === match[1])) {
          templateParams.path.push({
            ...DEFAULT_PATH_PARAM,
            name: match[1],
          });
        }
      }

      // 如果 path 没有内容，则将删除 path 参数，避免影响后续的 hasParams 判断
      if (!templateParams.path.length) delete templateParams.path;
    }

    return templateParams;
  }

  private resolveObject(schemaObject: ISchemaObject): unknown {
    // 不使用 schemaObject: ISchemaObject = {}
    schemaObject = schemaObject ?? ({} as ISchemaObject);

    // 引用类型
    if (isReferenceObject(schemaObject)) {
      return this.resolveRefObject(schemaObject);
    }

    // 枚举类型
    if (schemaObject.enum) {
      return this.resolveEnumObject(schemaObject);
    }

    // 继承类型
    if (schemaObject.allOf && schemaObject.allOf.length) {
      return this.resolveAllOfObject(schemaObject);
    }

    // 对象类型
    if (schemaObject.properties) {
      return this.resolveProperties(schemaObject);
    }

    // 数组类型
    if (isArraySchemaObject(schemaObject)) {
      return this.resolveArray(schemaObject);
    }

    return schemaObject;
  }

  private resolveArray(schemaObject: ArraySchemaObject) {
    if (isReferenceObject(schemaObject.items)) {
      const refName = getRefName(schemaObject.items);

      return {
        type: `${refName}[]`,
      };
    } else if (schemaObject.items?.enum) {
      return {
        type: this.getType(schemaObject, this.config.namespace),
      };
    }

    // 这里需要解析出具体属性，但由于 parser 层还不确定，所以暂时先返回 unknown[]
    return { type: 'unknown[]' };
  }

  private resolveProperties(schemaObject: SchemaObject) {
    return {
      props: [this.getProps(schemaObject)],
    };
  }

  private resolveEnumObject(schemaObject: SchemaObject) {
    const enumArray = schemaObject.enum;
    let enumStr = '';
    let enumLabelTypeStr = '';

    if (numberEnum.includes(schemaObject.type) || isAllNumber(enumArray)) {
      if (this.config.isSupportParseEnumDesc && schemaObject.description) {
        const enumMap = parseDescriptionEnum(schemaObject.description);
        enumStr = `{${map(enumArray, (value) => {
          const enumLabel = enumMap.get(Number(value));
          return `${enumLabel}=${Number(value)}`;
        }).join(',')}}`;
        log('enumStr', enumStr);
      } else {
        enumStr = `{${map(enumArray, (value) => `"NUMBER_${value}"=${Number(value)}`).join(',')}}`;
      }
    } else if (isAllNumeric(enumArray)) {
      enumStr = `{${map(enumArray, (value) => `"STRING_NUMBER_${value}"="${value}"`).join(',')}}`;
    } else {
      enumStr = `{${map(enumArray, (value) => `${value}="${value}"`).join(',')}}`;
    }

    // 翻译枚举
    if (schemaObject['x-enum-varnames'] && schemaObject['x-enum-comments']) {
      enumLabelTypeStr = `{${map(enumArray, (value, index) => {
        const enumKey = schemaObject['x-enum-varnames'][index];
        return `${value}:"${schemaObject['x-enum-comments'][enumKey]}"`;
      }).join(',')}}`;
    } else if (schemaObject?.['x-apifox']?.['enumDescriptions']) {
      enumLabelTypeStr = `{${map(enumArray, (value: string) => {
        const enumLabel = schemaObject['x-apifox']['enumDescriptions'][value];
        return `${value}:"${enumLabel}"`;
      }).join(',')}}`;
    } else if (schemaObject?.['x-apifox-enum']) {
      enumLabelTypeStr = `{${map(enumArray, (value: string) => {
        const enumLabel = find(
          schemaObject['x-apifox-enum'],
          (item) => item.value === value
        )?.description;
        return `${value}:"${enumLabel}"`;
      }).join(',')}}`;
    } else {
      if (numberEnum.includes(schemaObject.type) || isAllNumber(enumArray)) {
        if (this.config.isSupportParseEnumDesc && schemaObject.description) {
          const enumMap = parseDescriptionEnum(schemaObject.description);
          enumLabelTypeStr = `{${map(enumArray, (value) => {
            const enumLabel = enumMap.get(Number(value));
            return `"${enumLabel}":${Number(value)}`;
          }).join(',')}}`;
        } else {
          enumLabelTypeStr = `{${map(enumArray, (value) => `"NUMBER_${value}":${Number(value)}`).join(',')}}`;
        }
      } else if (isAllNumeric(enumArray)) {
        enumLabelTypeStr = `{${map(enumArray, (value) => `"STRING_NUMBER_${value}":"${value}"`).join(',')}}`;
      } else {
        enumLabelTypeStr = `{${map(enumArray, (value) => `${value}:"${value}"`).join(',')}}`;
      }
    }

    return {
      isEnum: true,
      type: Array.isArray(enumArray) ? enumStr : 'string',
      enumLabelType: enumLabelTypeStr,
    };
  }

  private resolveAllOfObject(schemaObject: SchemaObject) {
    const props = map(schemaObject.allOf, (item) => {
      return isReferenceObject(item)
        ? [{ ...item, type: this.getType(item) }]
        : this.getProps(item);
    });

    if (schemaObject.properties) {
      const extProps = this.getProps(schemaObject);

      return { props: [...props, extProps] };
    }

    return { props };
  }

  // 获取 TS 类型的属性列表
  private getProps(schemaObject: SchemaObject) {
    const requiredPropKeys = schemaObject?.required ?? false;
    const properties = schemaObject.properties;

    return keys(properties).map((propKey) => {
      const schema = (properties?.[propKey] || DEFAULT_SCHEMA) as SchemaObject;
      // 剔除属性键值中的特殊符号，因为函数入参变量存在特殊符号会导致解析文件失败
      // eslint-disable-next-line no-useless-escape
      propKey = propKey.replace(/[\[|\]]/g, '');

      // 复用 schema 部分字段
      return {
        ...schema,
        name: propKey,
        type: this.getType(schema),
        desc: [schema.title, schema.description]
          .filter((item) => item)
          .join(' ')
          .replace(lineBreakReg, ''),
        // 如果没有 required 信息，默认全部是非必填
        required: requiredPropKeys
          ? requiredPropKeys.some((key) => key === propKey)
          : false,
      };
    });
  }

  private resolveRefObject<T>(refObject: ReferenceObject | T): T {
    if (!isReferenceObject(refObject)) {
      return refObject;
    }

    const refPaths = refObject.$ref.split('/');

    if (refPaths[0] === '#') {
      const schema = resolveRefs(
        this.openAPIData,
        refPaths.slice(1)
      ) as ISchemaObject;

      if (!schema) {
        throw new Error(`[GenSDK] Data Error! Notfoud: ${refObject.$ref}`);
      }

      return {
        ...(this.resolveRefObject(schema) || {}),
        type: isReferenceObject(schema)
          ? this.resolveRefObject<SchemaObject>(schema).type
          : schema.type,
      } as T;
    }

    return refObject as T;
  }

  public log(message: string) {
    if (this.config.enableLogging) {
      log(message);
    }
  }

  private generateInfoLog(): void {
    this.log(`priorityRule: ${this.config?.priorityRule}`);

    if (this.config?.includeTags) {
      this.log(`includeTags: ${this.config?.includeTags.join(', ')}`);
    }

    if (this.config?.excludeTags) {
      this.log(`excludeTags: ${this.config?.excludeTags.join(', ')}`);
    }

    if (this.config?.includePaths) {
      this.log(`includePaths: ${this.config?.includePaths.join(', ')}`);
    }

    if (this.config?.excludePaths) {
      this.log(`excludePaths: ${this.config?.excludePaths.join(', ')}`);
    }
  }

  /**
   * 校验规则
   * @param regexp 正则数组
   * @param data 数据
   */
  private validateRegexp(
    data: string | string[],
    regexp: (string | RegExp)[]
  ): boolean {
    // 确保 data 是数组
    const dataArray = Array.isArray(data) ? data : [data];
    this.log(`"Data Array:", ${dataArray.join(',')}`);
    this.log(`"Regexp Array:", ${regexp.join(',')}`);

    return dataArray.some((item) => {
      const result = regexp.some((reg) => this.matches(item, reg));
      this.log(`"Item:", ${item}, "Matches:", ${result}`);

      return result;
    });
  }

  /**
   *
   * @param item 数组数据
   * @param reg 规则
   */
  // 提取匹配逻辑到单独的函数
  private matches(item: string, reg: string | RegExp): boolean {
    if (typeof reg === 'string') {
      return minimatch(item, reg);
    } else if (reg instanceof RegExp) {
      reg.lastIndex = 0; // 重置正则表达式的 lastIndex 属性

      return reg.test(item);
    }

    return false; // 对于其他类型，返回 false
  }
}
