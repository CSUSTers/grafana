import { escape, isString, property } from 'lodash';

import {
  deprecationWarning,
  ScopedVars,
  TimeRange,
  AdHocVariableFilter,
  AdHocVariableModel,
  TypedVariableModel,
  VariableMap,
} from '@grafana/data';
import { getDataSourceSrv, setTemplateSrv, TemplateSrv as BaseTemplateSrv } from '@grafana/runtime';
import { sceneGraph, FormatRegistryID, formatRegistry, CustomFormatterFn } from '@grafana/scenes';

import { variableAdapters } from '../variables/adapters';
import { ALL_VARIABLE_TEXT, ALL_VARIABLE_VALUE } from '../variables/constants';
import { isAdHoc } from '../variables/guard';
import { getFilteredVariables, getVariables, getVariableWithName } from '../variables/state/selectors';
import { variableRegex } from '../variables/utils';

import { getVariableWrapper } from './LegacyVariableWrapper';

interface FieldAccessorCache {
  [key: string]: (obj: any) => any;
}

export interface TemplateSrvDependencies {
  getFilteredVariables: typeof getFilteredVariables;
  getVariables: typeof getVariables;
  getVariableWithName: typeof getVariableWithName;
}

const runtimeDependencies: TemplateSrvDependencies = {
  getFilteredVariables,
  getVariables,
  getVariableWithName,
};

export class TemplateSrv implements BaseTemplateSrv {
  private _variables: any[];
  private regex = variableRegex;
  private index: any = {};
  private grafanaVariables = new Map<string, any>();
  private timeRange?: TimeRange | null = null;
  private fieldAccessorCache: FieldAccessorCache = {};

  constructor(private dependencies: TemplateSrvDependencies = runtimeDependencies) {
    this._variables = [];
  }

  init(variables: any, timeRange?: TimeRange) {
    this._variables = variables;
    this.timeRange = timeRange;
    this.updateIndex();
  }

  /**
   * @deprecated: this instance variable should not be used and will be removed in future releases
   *
   * Use getVariables function instead
   */
  get variables(): any[] {
    deprecationWarning('template_srv.ts', 'variables', 'getVariables');
    return this.getVariables();
  }

  getVariables(): TypedVariableModel[] {
    return this.dependencies.getVariables();
  }

  updateIndex() {
    const existsOrEmpty = (value: any) => value || value === '';

    this.index = this._variables.reduce((acc, currentValue) => {
      if (currentValue.current && (currentValue.current.isNone || existsOrEmpty(currentValue.current.value))) {
        acc[currentValue.name] = currentValue;
      }
      return acc;
    }, {});

    if (this.timeRange) {
      const from = this.timeRange.from.valueOf().toString();
      const to = this.timeRange.to.valueOf().toString();

      this.index = {
        ...this.index,
        ['__from']: {
          current: { value: from, text: from },
        },
        ['__to']: {
          current: { value: to, text: to },
        },
      };
    }
  }

  updateTimeRange(timeRange: TimeRange) {
    this.timeRange = timeRange;
    this.updateIndex();
  }

  variableInitialized(variable: any) {
    this.index[variable.name] = variable;
  }

  getAdhocFilters(datasourceName: string): AdHocVariableFilter[] {
    let filters: any = [];
    let ds = getDataSourceSrv().getInstanceSettings(datasourceName);

    if (!ds) {
      return [];
    }

    for (const variable of this.getAdHocVariables()) {
      const variableUid = variable.datasource?.uid;

      if (variableUid === ds.uid) {
        filters = filters.concat(variable.filters);
      } else if (variableUid?.indexOf('$') === 0) {
        if (this.replace(variableUid) === datasourceName) {
          filters = filters.concat(variable.filters);
        }
      }
    }

    return filters;
  }

  formatValue(value: any, format?: any, variable?: any, text?: string): string {
    // for some scopedVars there is no variable
    variable = variable || {};

    if (value === null || value === undefined) {
      return '';
    }

    if (isAdHoc(variable) && format !== FormatRegistryID.queryParam) {
      return '';
    }

    // if it's an object transform value to string
    if (!Array.isArray(value) && typeof value === 'object') {
      value = `${value}`;
    }

    if (typeof format === 'function') {
      return format(value, variable, this.formatValue);
    }

    if (!format) {
      format = FormatRegistryID.glob;
    }

    // some formats have arguments that come after ':' character
    let args = format.split(':');
    if (args.length > 1) {
      format = args[0];
      args = args.slice(1);
    } else {
      args = [];
    }

    let formatItem = formatRegistry.getIfExists(format);

    if (!formatItem) {
      console.error(`Variable format ${format} not found. Using glob format as fallback.`);
      formatItem = formatRegistry.get(FormatRegistryID.glob);
    }

    const formatVariable = getVariableWrapper(variable, value, text ?? value);
    return formatItem.formatter(value, args, formatVariable);
  }

  setGrafanaVariable(name: string, value: any) {
    this.grafanaVariables.set(name, value);
  }

  /**
   * @deprecated: setGlobalVariable function should not be used and will be removed in future releases
   *
   * Use addVariable action to add variables to Redux instead
   */
  setGlobalVariable(name: string, variable: any) {
    deprecationWarning('template_srv.ts', 'setGlobalVariable', '');
    this.index = {
      ...this.index,
      [name]: {
        current: variable,
      },
    };
  }

  getVariableName(expression: string) {
    this.regex.lastIndex = 0;
    const match = this.regex.exec(expression);
    if (!match) {
      return null;
    }
    const variableName = match.slice(1).find((match) => match !== undefined);
    return variableName;
  }

  containsTemplate(target: string | undefined): boolean {
    if (!target) {
      return false;
    }
    const name = this.getVariableName(target);
    const variable = name && this.getVariableAtIndex(name);
    return variable !== null && variable !== undefined;
  }

  variableExists(expression: string): boolean {
    deprecationWarning('template_srv.ts', 'variableExists', 'containsTemplate');
    return this.containsTemplate(expression);
  }

  highlightVariablesAsHtml(str: string) {
    if (!str || !isString(str)) {
      return str;
    }

    str = escape(str);
    this.regex.lastIndex = 0;
    return str.replace(this.regex, (match, var1, var2, fmt2, var3) => {
      if (this.getVariableAtIndex(var1 || var2 || var3)) {
        return '<span class="template-variable">' + match + '</span>';
      }
      return match;
    });
  }

  getAllValue(variable: any) {
    if (variable.allValue) {
      return variable.allValue;
    }
    const values = [];
    for (let i = 1; i < variable.options.length; i++) {
      values.push(variable.options[i].value);
    }
    return values;
  }

  private getFieldAccessor(fieldPath: string) {
    const accessor = this.fieldAccessorCache[fieldPath];
    if (accessor) {
      return accessor;
    }

    return (this.fieldAccessorCache[fieldPath] = property(fieldPath));
  }

  private getVariableValue(variableName: string, fieldPath: string | undefined, scopedVars: ScopedVars) {
    const scopedVar = scopedVars[variableName];
    if (!scopedVar) {
      return null;
    }

    if (fieldPath) {
      return this.getFieldAccessor(fieldPath)(scopedVar.value);
    }

    return scopedVar.value;
  }

  private getVariableText(variableName: string, value: any, scopedVars: ScopedVars) {
    const scopedVar = scopedVars[variableName];

    if (!scopedVar) {
      return null;
    }

    if (scopedVar.value === value || typeof value !== 'string') {
      return scopedVar.text;
    }

    return value;
  }

  replace(target?: string, scopedVars?: ScopedVars, format?: string | Function): string {
    if (scopedVars && scopedVars.__sceneObject) {
      return sceneGraph.interpolate(
        scopedVars.__sceneObject.value,
        target,
        scopedVars,
        format as string | CustomFormatterFn | undefined
      );
    }

    if (!target) {
      return target ?? '';
    }

    this.regex.lastIndex = 0;

    return target.replace(this.regex, (match, var1, var2, fmt2, var3, fieldPath, fmt3) => {
      const variableName = var1 || var2 || var3;
      const variable = this.getVariableAtIndex(variableName);
      let fmt = fmt2 || fmt3 || format;

      if (scopedVars) {
        const value = this.getVariableValue(variableName, fieldPath, scopedVars);
        const text = this.getVariableText(variableName, value, scopedVars);

        if (value !== null && value !== undefined) {
          if (scopedVars[variableName].skipFormat) {
            fmt = undefined;
          }

          return this.formatValue(value, fmt, variable, text);
        }
      }

      if (!variable) {
        return match;
      }

      if (fmt === FormatRegistryID.queryParam || isAdHoc(variable)) {
        const value = variableAdapters.get(variable.type).getValueForUrl(variable);
        const text = isAdHoc(variable) ? variable.id : variable.current.text;

        return this.formatValue(value, fmt, variable, text);
      }

      const systemValue = this.grafanaVariables.get(variable.current.value);
      if (systemValue) {
        return this.formatValue(systemValue, fmt, variable);
      }

      let value = variable.current.value;
      let text = variable.current.text;

      if (this.isAllValue(value)) {
        value = this.getAllValue(variable);
        text = ALL_VARIABLE_TEXT;
        // skip formatting of custom all values
        if (variable.allValue && fmt !== FormatRegistryID.text) {
          return this.replace(value);
        }
      }

      if (fieldPath) {
        const fieldValue = this.getVariableValue(variableName, fieldPath, {
          [variableName]: { value, text },
        });
        if (fieldValue !== null && fieldValue !== undefined) {
          return this.formatValue(fieldValue, fmt, variable, text);
        }
      }

      const res = this.formatValue(value, fmt, variable, text);
      return res;
    });
  }

  getAllVariablesInTarget(target: string, scopedVars: ScopedVars, format?: string | Function): VariableMap {
    const values: VariableMap = {};

    this.replaceInVariableRegex(target, (match, var1, var2, fmt2, var3, fieldPath, fmt3) => {
      const variableName = var1 || var2 || var3;
      const variableDisplayName =
        var1 || var2 || (var3 !== undefined && fieldPath !== undefined) ? `${var3}.${fieldPath}` : var3;
      const fmt = fmt2 || fmt3 || format;
      const value = this.getVariableValue(variableName, fieldPath, scopedVars);
      if (value !== null && value !== undefined) {
        const variable = this.getVariableAtIndex(variableName);
        const text = this.getVariableText(variableName, value, scopedVars);
        values[variableDisplayName] = this.formatValue(value, fmt, variable, text);
      } else {
        values[variableDisplayName] = undefined;
      }

      // Don't care about the result anyway
      return '';
    });

    return values;
  }

  /**
   * The replace function, for every match, will return a function that has the full match as a param
   * followed by one param per capture group of the variable regex.
   *
   * See the definition of this.regex for further comments on the variable definitions.
   */
  private replaceInVariableRegex(
    text: string,
    replace: (
      fullMatch: string, //     $simpleVarName   [[squareVarName:squareFormat]]   ${curlyVarName.curlyPath:curlyFormat}
      simpleVarName: string, // simpleVarName                  -                                     -
      squareVarName: string, //        -                squareVarName                                -
      squareFormat: string, //         -                squareFormat                                 -
      curlyVarName: string, //         -                      -                                curlyVarName
      curlyPath: string, //            -                      -                                  curlyPath
      curlyFormat: string //           -                      -                                 curlyFormat
    ) => string
  ) {
    return text.replace(this.regex, replace);
  }

  isAllValue(value: any) {
    return value === ALL_VARIABLE_VALUE || (Array.isArray(value) && value[0] === ALL_VARIABLE_VALUE);
  }

  replaceWithText(target: string, scopedVars?: ScopedVars) {
    deprecationWarning('template_srv.ts', 'replaceWithText()', 'replace(), and specify the :text format');
    return this.replace(target, scopedVars, 'text');
  }

  private getVariableAtIndex(name: string) {
    if (!name) {
      return;
    }

    if (!this.index[name]) {
      return this.dependencies.getVariableWithName(name);
    }

    return this.index[name];
  }

  private getAdHocVariables(): AdHocVariableModel[] {
    return this.dependencies.getFilteredVariables(isAdHoc) as AdHocVariableModel[];
  }
}

// Expose the template srv
const srv = new TemplateSrv();

setTemplateSrv(srv);

export const getTemplateSrv = () => srv;
