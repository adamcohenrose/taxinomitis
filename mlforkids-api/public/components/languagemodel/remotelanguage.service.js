(function () {

    angular
        .module('app')
        .service('remoteLanguageModelService', remoteLanguageModelService);

    remoteLanguageModelService.$inject = [ '$window' ];

    function remoteLanguageModelService($window) {

        function normalizeServerUrl(serverUrl) {
            if (!serverUrl || typeof serverUrl !== 'string') {
                throw new Error('Enter the URL for the oMLX server.');
            }

            let parsed;
            try {
                parsed = new URL(serverUrl.trim());
            }
            catch (err) {
                throw new Error('Enter a valid oMLX server URL, including http:// or https://.');
            }

            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                throw new Error('The oMLX server URL must start with http:// or https://.');
            }
            if ($window.location.protocol === 'https:' && parsed.protocol === 'http:') {
                throw new Error('This page uses HTTPS, so browsers cannot connect to an HTTP oMLX URL. Ask your teacher for an HTTPS server URL.');
            }
            if (!parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
                throw new Error('Enter the oMLX server address only, without a username, password, query, or fragment.');
            }

            let pathname = parsed.pathname.replace(/\/+$/, '');
            if (!pathname.endsWith('/v1')) {
                pathname += '/v1';
            }
            parsed.pathname = pathname;

            return parsed.toString().replace(/\/$/, '');
        }

        function getErrorMessage(response) {
            return response.text()
                .then((body) => {
                    try {
                        const parsed = JSON.parse(body);
                        return (parsed.error && parsed.error.message) || parsed.detail || body;
                    }
                    catch (err) {
                        return body;
                    }
                })
                .then((message) => {
                    const fallback = 'oMLX returned HTTP ' + response.status + '.';
                    return message ? String(message) : fallback;
                });
        }

        function fetchFailed(err) {
            if (err && err.name === 'AbortError') {
                return err;
            }
            return new Error('Could not reach the oMLX server. Check the URL, network connection, CORS settings, and that unauthenticated inference is enabled.');
        }

        function getModels(serverUrl) {
            const apiBaseUrl = normalizeServerUrl(serverUrl);

            return $window.fetch(apiBaseUrl + '/models', {
                method : 'GET',
                headers : { Accept : 'application/json' },
                credentials : 'omit'
            })
                .catch((err) => { throw fetchFailed(err); })
                .then((response) => {
                    if (!response.ok) {
                        return getErrorMessage(response).then((message) => {
                            throw new Error(message);
                        });
                    }
                    return response.json();
                })
                .then((payload) => {
                    const models = (payload && Array.isArray(payload.data) ? payload.data : [])
                        .filter((model) => model && typeof model.id === 'string' && model.id.length > 0)
                        .map((model) => ({ id : model.id }));

                    if (models.length === 0) {
                        throw new Error('The oMLX server did not report any available models.');
                    }

                    return { apiBaseUrl, models };
                });
        }

        function dispatchEventData(data, onDelta) {
            if (!data || data === '[DONE]') {
                return;
            }

            let payload;
            try {
                payload = JSON.parse(data);
            }
            catch (err) {
                throw new Error('The oMLX server sent an invalid streaming response.');
            }

            if (payload.error) {
                throw new Error(payload.error.message || 'The oMLX server could not complete the prompt.');
            }

            const content = payload.choices && payload.choices[0] &&
                            payload.choices[0].delta && payload.choices[0].delta.content;
            if (typeof content === 'string' && content.length > 0) {
                onDelta(content);
            }
        }

        async function streamCompletion(serverUrl, model, messages, temperature, topP, signal, onDelta) {
            const apiBaseUrl = normalizeServerUrl(serverUrl);
            let response;

            try {
                response = await $window.fetch(apiBaseUrl + '/chat/completions', {
                    method : 'POST',
                    headers : {
                        Accept : 'text/event-stream',
                        'Content-Type' : 'application/json'
                    },
                    credentials : 'omit',
                    signal : signal,
                    body : JSON.stringify({
                        model : model,
                        messages : messages,
                        temperature : temperature,
                        top_p : topP,
                        stream : true
                    })
                });
            }
            catch (err) {
                throw fetchFailed(err);
            }

            if (!response.ok) {
                const message = await getErrorMessage(response);
                throw new Error(message);
            }

            if (!response.body || !response.body.getReader) {
                throw new Error('The oMLX server did not return a streaming response.');
            }

            const reader = response.body.getReader();
            const decoder = new $window.TextDecoder();
            let buffer = '';
            let dataLines = [];

            function dispatchEvent() {
                if (dataLines.length > 0) {
                    dispatchEventData(dataLines.join('\n'), onDelta);
                    dataLines = [];
                }
            }

            while (true) {
                const result = await reader.read();
                buffer += decoder.decode(result.value || new Uint8Array(), { stream : !result.done });

                const lines = buffer.split('\n');
                buffer = lines.pop();
                for (let line of lines) {
                    if (line.endsWith('\r')) {
                        line = line.substring(0, line.length - 1);
                    }
                    if (line.length === 0) {
                        dispatchEvent();
                    }
                    else if (line.startsWith('data:')) {
                        dataLines.push(line.substring(5).replace(/^ /, ''));
                    }
                }

                if (result.done) {
                    if (buffer.length > 0 && buffer.startsWith('data:')) {
                        dataLines.push(buffer.substring(5).replace(/^ /, ''));
                    }
                    dispatchEvent();
                    return;
                }
            }
        }

        return {
            getModels,
            normalizeServerUrl,
            streamCompletion
        };
    }
})();
