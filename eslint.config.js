import js from '@eslint/js'
import globals from 'globals'
import react from 'eslint-plugin-react'
import hooks from 'eslint-plugin-react-hooks'
export default [
 { ignores:['node_modules/**','dist/**','public/ocr/**','audit-evidence/**'] },
 { files:['src/**/*.{js,jsx}','public/notification-worker.js'],languageOptions:{ecmaVersion:2022,sourceType:'module',parserOptions:{ecmaFeatures:{jsx:true}},globals:{...globals.browser,...globals.node,...globals.serviceworker}},plugins:{react,'react-hooks':hooks},rules:{...js.configs.recommended.rules,'react/jsx-uses-vars':'error','react/jsx-uses-react':'error','react-hooks/rules-of-hooks':'error','no-unused-vars':['warn',{varsIgnorePattern:'^_',argsIgnorePattern:'^_',caughtErrorsIgnorePattern:'^_'}],'no-empty':['error',{allowEmptyCatch:true}],'no-duplicate-imports':'error'} },
]
