describe('remoteLanguageModelService', function () {

    var service;
    var $window;
    var originalFetch;

    beforeEach(module('app'));

    beforeEach(inject(function (_remoteLanguageModelService_, _$window_) {
        service = _remoteLanguageModelService_;
        $window = _$window_;
        originalFetch = $window.fetch;
        $window.fetch = jasmine.createSpy('fetch');
    }));

    afterEach(function () {
        $window.fetch = originalFetch;
    });

    it('normalizes an oMLX server URL with or without the v1 path', function () {
        expect(service.normalizeServerUrl(' http://teacher-laptop:8000/ '))
            .toBe('http://teacher-laptop:8000/v1');
        expect(service.normalizeServerUrl('http://teacher-laptop:8000/v1/'))
            .toBe('http://teacher-laptop:8000/v1');
    });

    it('rejects unsupported URL schemes and embedded credentials', function () {
        expect(function () { service.normalizeServerUrl('ftp://teacher-laptop:8000'); })
            .toThrowError('The oMLX server URL must start with http:// or https://.');
        expect(function () { service.normalizeServerUrl('http://student:secret@teacher-laptop:8000'); })
            .toThrowError('Enter the oMLX server address only, without a username, password, query, or fragment.');
    });

    it('discovers model IDs from the OpenAI-compatible models endpoint', async function () {
        $window.fetch.and.returnValue(Promise.resolve({
            ok : true,
            json : function () {
                return Promise.resolve({ data : [ { id : 'school-model' }, { id : 'another-model' } ] });
            }
        }));

        var result = await service.getModels('http://teacher-laptop:8000');

        expect($window.fetch.calls.mostRecent().args[0]).toBe('http://teacher-laptop:8000/v1/models');
        expect($window.fetch.calls.mostRecent().args[1].credentials).toBe('omit');
        expect(result).toEqual({
            apiBaseUrl : 'http://teacher-laptop:8000/v1',
            models : [ { id : 'school-model' }, { id : 'another-model' } ]
        });
    });

    it('posts a streaming chat completion with the initial context and emits text deltas', async function () {
        var encoder = new TextEncoder();
        var payload = [
            'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":" there"}}]}\n\n',
            'data: [DONE]\n\n'
        ].join('');
        var chunks = [
            encoder.encode(payload.substring(0, 31)),
            encoder.encode(payload.substring(31, 76)),
            encoder.encode(payload.substring(76))
        ];
        var chunkIdx = 0;
        $window.fetch.and.returnValue(Promise.resolve({
            ok : true,
            body : {
                getReader : function () {
                    return {
                        read : function () {
                            if (chunkIdx < chunks.length) {
                                return Promise.resolve({ value : chunks[chunkIdx++], done : false });
                            }
                            return Promise.resolve({ done : true });
                        }
                    };
                }
            }
        }));
        var deltas = [];

        await service.streamCompletion(
            'http://teacher-laptop:8000/v1',
            'school-model',
            [ { role : 'user', content : 'Question: Say hello\n\nContext:\nCats are mammals.' } ],
            0.7,
            0.8,
            new AbortController().signal,
            function (delta) { deltas.push(delta); }
        );

        var request = $window.fetch.calls.mostRecent();
        expect(request.args[0]).toBe('http://teacher-laptop:8000/v1/chat/completions');
        expect(JSON.parse(request.args[1].body)).toEqual({
            model : 'school-model',
            messages : [ { role : 'user', content : 'Question: Say hello\n\nContext:\nCats are mammals.' } ],
            temperature : 0.7,
            top_p : 0.8,
            stream : true
        });
        expect(deltas.join('')).toBe('Hello there');
    });

});
