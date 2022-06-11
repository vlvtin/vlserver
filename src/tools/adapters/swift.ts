import { ServiceAdapter } from "./base";
import * as fs from "fs";

export class SwiftServiceAdapter extends ServiceAdapter {
	typeMappings = {
		string: "String",
		number: "Double",
		boolean: "Bool",
		Date: "Date",
		Buffer: "Data"
	}

	getType(type) {
		if (type in this.typeMappings) {
			return this.typeMappings[type];
		}
		
		return type;
	}

	generate(routes, viewModels, config) {
		const controllers = routes.map(r => r.controller).filter((c, i, a) => a.indexOf(c) == i);

		fs.writeFileSync(this.outFile, `
import Foundation

class Service {
	static var baseUrl = ""

	static var prepareRequest: (_ url: URL) -> URLRequest = {
        url in
        
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        
        return request
    }
	
	func toURL(route: String) -> String {
		return "\\(Service.baseUrl)\\(route)"
	}
    
    static func createRequest(url: URL) -> URLRequest {
        return prepareRequest(url)
    }
}

class RequestBody {
	var boundary: String
	var body: NSMutableData
	
	init() {
		boundary = "Boundary-\\(UUID().uuidString)"
		
		self.body = NSMutableData()
	}

	var header: String {
		return "multipart/form-data; boundary=----\\(boundary)"
	}
	
	func append(name: String, data: Data) {
		body.append("------\\(boundary)\\r\\n".data(using: .ascii)!)
		body.append("Content-Disposition: form-data; name=\\"\\(name)\\"\\r\\n\\r\\n".data(using: .ascii)!)
		body.append(data)
		body.append("\\r\\n".data(using: .ascii)!)
	}

	func appendFile(name: String, data: Data) {
		body.append("------\\(boundary)\\r\\n".data(using: .ascii)!)
		body.append("Content-Disposition: form-data; name=\\"\\(name)\\"; filename=\\"\\(name)\\"\\r\\n\\r\\n".data(using: .ascii)!)
		body.append("Content-Type: application/octet-stream".data(using: .ascii)!)
		body.append(data)
		body.append("\\r\\n".data(using: .ascii)!)
	}
	
	func create() -> Data {
		body.append("------\\(boundary)--".data(using: .ascii)!)
		
		return Data(body as Data)
	}
}

class ServiceError : Error {
	var message: String
	
	init(message: String) {
		self.message = message
	}
}

${viewModels.map(viewModel => `
class ${viewModel.name} : Codable, Hashable, Identifiable {
	${Object.keys(viewModel.properties).map(name => {
		const property = viewModel.properties[name];
		const isArray = property.fetch && property.fetch.many;

		return `var ${name}: ${isArray ? "[" : ""}${this.getType(property.propertyType)}${isArray ? "]" : ""}?`;
	}).join("\n\t")}

	public init(${Object.keys(viewModel.properties).map(name => {
		const property = viewModel.properties[name];
		const isArray = property.fetch && property.fetch.many;

		return `${name}: ${isArray ? "[" : ""}${this.getType(property.propertyType)}${isArray ? "]" : ""}?`;
	}).join(", ")}) {
        ${Object.keys(viewModel.properties).map(name => {
			const property = viewModel.properties[name];
			const isArray = property.fetch && property.fetch.many;
	
			return `self.${name} = ${name}`;
		}).join("\n\t\t")}
    }

	static func == (lhs: ${viewModel.name}, rhs: ${viewModel.name}) -> Bool {
        return lhs.id == rhs.id
    }
    
    func hash(into hasher: inout Hasher) {
        hasher.combine(id)
    }
}
`.trim()).join("\n\n")}

${controllers.map(controller => `

class ${controller.name} : Service {
	${routes.filter(r => r.controller == controller).map(route => {
		const isVoid = route.returnType[route.returnType.length - 1] == "void";

		return `

	func ${route.name}(${[
		...route.parameters.map(
			parameter => `${parameter.name}: ${parameter.isArray ? "[" : ""}${this.getType(parameter.type)}${parameter.isArray ? "]" : ""}`
		),
		`completionHandler: @escaping (Error?${isVoid ? "" : `, ${
			route.returnType.slice(0, route.returnType.length - 1).map(t => `[`)
		}${
			this.getType(route.returnType[route.returnType.length - 1])
		}${
			"]".repeat(route.returnType.length - 1)
		}?`}) -> Void`
	].join(", ")}) {
		let endpoint = URL(string: toURL(route: ${JSON.stringify(route.id)}))
		var request = Service.createRequest(url: endpoint!)
		
		let body = RequestBody()
		${route.parameters.map(
			parameter => `body.${parameter.type == 'Buffer' ? 'appendFile' : 'append'}(name: ${JSON.stringify(parameter.id)}, data: ${parameter.type == 'Buffer' ? parameter.name : `try! JSONEncoder().encode(${parameter.name})`})`
		).join("\n\t\t")}
		
		request.setValue(body.header, forHTTPHeaderField: "Content-Type")
		request.httpBody = body.create()
		
		let task = URLSession.shared.dataTask(with: request) { (data, response, error) in
			if error != nil {
				completionHandler(error${isVoid ? "" : ", nil"})
				
				return
			}

			class ResponseBody : Codable {
				${isVoid ? "" : `var data: ${
					route.returnType.slice(0, route.returnType.length - 1).map(t => `[`)
				}${
					this.getType(route.returnType[route.returnType.length - 1])
				}${
					"]".repeat(route.returnType.length - 1)
				}?`}
				var aborted: Bool?
				var error: String?
			}
			
			do {
				let res = try JSONDecoder().decode(ResponseBody.self, from: data!)
				
				if res.error != nil {
					throw ServiceError(message: res.error!)
				} else if res.aborted == true {
					throw ServiceError(message: "request aborted by server")
				} else {
					completionHandler(nil${isVoid ? "" : ", res.data"})
				}
			} catch let error {
				completionHandler(error${isVoid ? "" : ", nil"})
			}
		}
		
		task.resume()
	}
		`.trim()
	}).join("\n\n\t")}
}
`.trim()).join("\n\n")}`.trim());
	}
}