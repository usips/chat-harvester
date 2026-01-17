const path = require('path');
const fs = require('fs');
const webpack = require('webpack');

// Read the userscript header
const userscriptHeader = fs.readFileSync(
    path.resolve(__dirname, 'templates/userscript-header.txt'),
    'utf8'
);

module.exports = {
    mode: 'production',
    entry: path.resolve(__dirname, 'src/userscript.ts'),
    output: {
        filename: 'chuck.user.js',
        path: path.resolve(__dirname, 'dist'),
    },
    resolve: {
        extensions: ['.ts', '.js'],
        fullySpecified: false,
        extensionAlias: {
            '.js': ['.ts', '.js'],
        },
    },
    target: 'web',
    optimization: {
        minimize: false, // Keep readable for userscript debugging
    },
    experiments: {
        outputModule: false,
    },
    plugins: [
        new webpack.BannerPlugin({
            banner: userscriptHeader,
            raw: true,
            entryOnly: true,
        }),
    ],
    module: {
        rules: [
            {
                test: /\.ts$/,
                use: 'ts-loader',
                exclude: /node_modules/,
            },
            {
                test: /\.js$/,
                type: 'javascript/auto',
            }
        ]
    }
};
